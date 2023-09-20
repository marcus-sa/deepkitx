import { ClassType } from '@deepkit/core';
import {
  AnnotationDefinition,
  ReceiveType,
  ReflectionClass,
  ReflectionKind,
  ReflectionParameter,
  resolveReceiveType,
  resolveRuntimeType,
  Type,
  TypeArray,
  TypeClass,
  TypeEnum,
  TypeNumberBrand,
  TypeObjectLiteral,
  TypePromise,
  TypeUnion,
} from '@deepkit/type';
import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLEnumValueConfigMap,
  GraphQLFieldConfig,
  GraphQLFieldConfigMap,
  GraphQLFloat,
  GraphQLID,
  GraphQLInputObjectType,
  GraphQLInputType,
  GraphQLInt,
  GraphQLList,
  GraphQLNamedInputType,
  GraphQLNamedOutputType,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLOutputType,
  GraphQLScalarType,
  GraphQLString,
  GraphQLUnionType,
} from 'graphql';
import {
  GraphQLBigInt,
  GraphQLByte,
  GraphQLNegativeFloat,
  GraphQLNegativeInt,
  GraphQLNonNegativeFloat,
  GraphQLNonNegativeInt,
  GraphQLNonPositiveFloat,
  GraphQLNonPositiveInt,
  GraphQLPositiveFloat,
  GraphQLPositiveInt,
  GraphQLTimestamp,
  GraphQLUUID,
} from 'graphql-scalars';

import { gqlResolverDecorator, typeResolvers } from './decorators';
import {
  createResolveFunction,
  filterReflectionParametersMetaAnnotationsForArguments,
  Resolvers,
} from './resolvers';

// eslint-disable-next-line @typescript-eslint/ban-types
export type Instance<T = any> = T & { readonly constructor: Function };

export type ID = string | number;

export function unwrapPromiseType(type: TypePromise): Type {
  return type.type;
}

export function getTypeName(
  type: TypeObjectLiteral | TypeClass | TypeUnion,
): string | undefined {
  return type.kind === ReflectionKind.class
    ? type.classType.name
    : type.typeName;
}

export class TypeNameRequiredError extends Error {
  constructor(readonly type: Type) {
    super('Type requires a name');
  }
}

export function requireTypeName(type: TypeObjectLiteral | TypeClass): string {
  const name = getTypeName(type);
  if (!name) {
    throw new TypeNameRequiredError(type);
  }
  return name;
}

export type GraphQLFields<T> = Record<string, { readonly type: T }>;

export const PARENT_META_NAME = 'parent';

// eslint-disable-next-line functional/prefer-readonly-type
export type Parent<T> = T & { __meta?: [typeof PARENT_META_NAME, T] };

export const CONTEXT_META_NAME = 'context';

// eslint-disable-next-line functional/prefer-readonly-type
export type Context<T> = T & { __meta?: [typeof CONTEXT_META_NAME, T] };

export class TypesBuilder {
  private readonly outputObjectTypes = new Map<string, GraphQLObjectType>();

  private readonly enumTypes = new WeakMap<TypeEnum, GraphQLEnumType>();

  private readonly unionTypes = new WeakMap<TypeUnion, GraphQLUnionType>();

  private readonly inputObjectTypes = new Map<string, GraphQLInputObjectType>();

  constructor(private readonly resolvers?: Resolvers) {}

  getScalarType(type: Type): GraphQLScalarType {
    if (type.typeName === 'ID') return GraphQLID;

    switch (type.kind) {
      case ReflectionKind.boolean:
        return GraphQLBoolean;

      case ReflectionKind.class:
        return this.getScalarTypeForClass(type);

      case ReflectionKind.bigint:
        return GraphQLBigInt;

      case ReflectionKind.number: {
        const hasPositiveNoZeroDecorator = type.decorators?.find(
          decorator => decorator.typeName === 'PositiveNoZero',
        );
        const hasPositiveDecorator = type.decorators?.find(
          decorator => decorator.typeName === 'Positive',
        );
        const hasNegativeNoZeroDecorator = type.decorators?.find(
          decorator => decorator.typeName === 'NegativeNoZero',
        );
        const hasNegativeDecorator = type.decorators?.find(
          decorator => decorator.typeName === 'Negative',
        );

        if (
          type.brand === TypeNumberBrand.float ||
          type.brand === TypeNumberBrand.float32 ||
          type.brand === TypeNumberBrand.float64
        ) {
          if (hasPositiveNoZeroDecorator) return GraphQLPositiveFloat;
          if (hasNegativeNoZeroDecorator) return GraphQLNegativeFloat;
          if (hasNegativeDecorator) return GraphQLNonPositiveFloat;
          if (hasPositiveDecorator) return GraphQLNonNegativeFloat;
          return GraphQLFloat;
        }

        if (
          type.brand === TypeNumberBrand.uint8 ||
          type.brand === TypeNumberBrand.uint16 ||
          type.brand === TypeNumberBrand.uint32
        ) {
          return GraphQLPositiveInt;
        }

        if (
          type.brand === TypeNumberBrand.integer ||
          type.brand === TypeNumberBrand.int8 ||
          type.brand === TypeNumberBrand.int16 ||
          type.brand === TypeNumberBrand.int32
        ) {
          if (hasPositiveNoZeroDecorator) return GraphQLPositiveInt;
          if (hasNegativeNoZeroDecorator) return GraphQLNegativeInt;
          if (hasNegativeDecorator) return GraphQLNonPositiveInt;
          if (hasPositiveDecorator) return GraphQLNonNegativeInt;
          return GraphQLInt;
        }

        throw new Error(`Add a decorator to type "number"`);
      }

      case ReflectionKind.literal:
        return GraphQLString;

      case ReflectionKind.string:
        if (type.typeName === 'UUID') return GraphQLUUID;
        return GraphQLString;

      default:
        console.log(type);
        throw new Error(`Kind ${type.kind} is not supported`);
    }
  }

  createEnumType(type: TypeEnum): GraphQLEnumType {
    if (this.enumTypes.has(type)) {
      return this.enumTypes.get(type)!;
    }

    if (!type.typeName) {
      throw new TypeNameRequiredError(type);
    }

    const enumType = new GraphQLEnumType({
      name: type.typeName,
      values: Object.entries(type.enum).reduce<GraphQLEnumValueConfigMap>(
        (values, [key, value]) => ({
          [key]: { value },
          ...values,
        }),
        {},
      ),
    });
    this.enumTypes.set(type, enumType);

    return enumType;
  }

  createUnionType(type: TypeUnion): GraphQLUnionType {
    if (this.unionTypes.has(type)) {
      return this.unionTypes.get(type)!;
    }

    const typesWithoutNullAndUndefined = type.types.filter(
      type =>
        type.kind !== ReflectionKind.undefined &&
        type.kind !== ReflectionKind.null,
    );

    const types = typesWithoutNullAndUndefined.map(type => {
      if (
        type.kind !== ReflectionKind.class &&
        type.kind !== ReflectionKind.objectLiteral
      ) {
        throw new Error('Only classes and interfaces are supported for unions');
      }

      return this.createOutputObjectType(type);
    });

    if (!type.typeName) {
      throw new Error('Type must be referenced and named');
    }

    const unionType = new GraphQLUnionType({
      name: type.typeName,
      types,
    });
    this.unionTypes.set(type, unionType);

    return unionType;
  }

  createInputListType(type: TypeArray): GraphQLList<GraphQLInputType> {
    const listType = this.createInputType(type.type);
    return new GraphQLList(listType);
  }

  createOutputListType<T extends GraphQLOutputType>(
    type: TypeArray,
  ): GraphQLList<GraphQLOutputType> {
    const listType = this.createOutputType(type.type);
    return new GraphQLList(listType);
  }

  getScalarTypeForClass(type: TypeClass): GraphQLScalarType {
    switch (type.classType.name) {
      case Date.name:
        return GraphQLTimestamp;

      case ArrayBuffer.name:
      case Uint8Array.name:
        return GraphQLByte;

      default:
        throw new Error(
          `${type.classType.name} is not a supported scalar type`,
        );
    }
  }

  createNamedInputType<T>(type?: ReceiveType<T>): GraphQLNamedInputType {
    type = resolveReceiveType(type);

    if (type.typeName === 'ID') return GraphQLID;

    switch (type.kind) {
      case ReflectionKind.propertySignature:
        return this.createNamedInputType(type.type);

      case ReflectionKind.objectLiteral:
        return this.createNamedInputType(type);

      case ReflectionKind.class: {
        try {
          return this.getScalarTypeForClass(type);
        } catch {
          return this.createNamedInputType(type);
        }
      }

      case ReflectionKind.enum:
        return this.createEnumType(type);

      default:
        return this.getScalarType(type);
    }
  }

  createInputType<T>(type?: ReceiveType<T>): GraphQLInputType {
    type = resolveReceiveType(type);

    if (type.typeName === 'ID') return GraphQLID;

    switch (type.kind) {
      case ReflectionKind.propertySignature:
        return this.createInputType(type.type);

      case ReflectionKind.objectLiteral:
        return this.createInputObjectType(type);

      case ReflectionKind.class: {
        try {
          return this.getScalarTypeForClass(type);
        } catch {
          return this.createInputObjectType(type);
        }
      }

      case ReflectionKind.array:
        return this.createInputListType(type);

      case ReflectionKind.enum:
        return this.createEnumType(type);

      default:
        return this.getScalarType(type);
    }
  }

  createNamedOutputType<T>(type?: ReceiveType<T>): GraphQLNamedOutputType {
    type = resolveReceiveType(type);

    if (type.typeName === 'ID') return GraphQLID;

    switch (type.kind) {
      case ReflectionKind.union: {
        const typesWithoutNullAndUndefined = type.types.filter(
          type =>
            type.kind !== ReflectionKind.undefined &&
            type.kind !== ReflectionKind.null,
        );

        if (typesWithoutNullAndUndefined.length === 1) {
          return this.createNamedOutputType(typesWithoutNullAndUndefined[0]);
        }

        return this.createUnionType(type);
      }

      case ReflectionKind.propertySignature:
        return this.createNamedOutputType(type.type);

      case ReflectionKind.objectLiteral:
        return this.createOutputObjectType(type);

      case ReflectionKind.class: {
        try {
          return this.getScalarTypeForClass(type);
        } catch {
          return this.createOutputObjectType(type);
        }
      }

      case ReflectionKind.enum:
        return this.createEnumType(type);

      default:
        return this.getScalarType(type);
    }
  }

  createOutputType<T>(type?: ReceiveType<T>): GraphQLOutputType {
    type = resolveReceiveType(type);

    if (type.typeName === 'ID') return GraphQLID;

    switch (type.kind) {
      case ReflectionKind.union: {
        const typesWithoutNullAndUndefined = type.types.filter(
          type =>
            type.kind !== ReflectionKind.undefined &&
            type.kind !== ReflectionKind.null,
        );

        if (typesWithoutNullAndUndefined.length === 1) {
          return this.createOutputType(typesWithoutNullAndUndefined[0]);
        }

        return this.createUnionType(type);
      }

      case ReflectionKind.propertySignature:
        return this.createOutputType(type.type);

      case ReflectionKind.objectLiteral:
        return this.createOutputObjectType(type);

      case ReflectionKind.class: {
        try {
          return this.getScalarTypeForClass(type);
        } catch {
          return this.createOutputObjectType(type);
        }
      }

      case ReflectionKind.array:
        return this.createOutputListType(type);

      case ReflectionKind.enum:
        return this.createEnumType(type);

      default:
        return this.getScalarType(type);
    }
  }

  getResolver(type: TypeClass | TypeObjectLiteral): Instance | undefined {
    const typeName = requireTypeName(type);
    const resolverClassType = typeResolvers.get(typeName);
    return resolverClassType && this.resolvers?.get(resolverClassType);
  }

  createOutputFields(
    type: TypeClass | TypeObjectLiteral,
  ): GraphQLFieldConfigMap<unknown, unknown> {
    const reflectionClass = ReflectionClass.from(type);

    const resolver = this.getResolver(type);

    return Object.fromEntries(
      reflectionClass.getProperties().map(property => {
        let type = this.createOutputType(property.type);
        if (!property.isOptional() && !property.isNullable()) {
          type = new GraphQLNonNull(type);
        }

        let config: GraphQLFieldConfig<unknown, unknown> = { type };

        if (resolver && this.hasFieldResolver(resolver, property.name)) {
          // eslint-disable-next-line functional/immutable-data
          config = Object.assign(
            config,
            this.generateFieldResolver(resolver, property.name),
          );
        }

        return [property.name, config];
      }),
    ) as GraphQLFieldConfigMap<unknown, unknown>;
  }

  createReturnType(type: Type): GraphQLOutputType {
    type =
      type.kind === ReflectionKind.promise ? unwrapPromiseType(type) : type;

    const isNull =
      type.kind === ReflectionKind.union &&
      type.types.some(
        type =>
          type.kind === ReflectionKind.null ||
          type.kind === ReflectionKind.undefined,
      );

    const outputType = this.createOutputType(type);

    return isNull ? outputType : new GraphQLNonNull(outputType);
  }

  createInputArgsFromReflectionParameters(
    parameters: readonly ReflectionParameter[],
  ) {
    const argsParameters =
      filterReflectionParametersMetaAnnotationsForArguments(parameters);

    return argsParameters.reduce((args, parameter) => {
      let type = this.createInputType(parameter.type);
      // TODO: assert for null
      if (!parameter.isOptional()) {
        type = new GraphQLNonNull(type);
      }

      const defaultValue = parameter.getDefaultValue();

      const argument = { type, defaultValue };

      return { ...args, [parameter.name]: argument };
    }, {});
  }

  createInputFields(
    type: TypeClass | TypeObjectLiteral,
  ): GraphQLFields<GraphQLInputType> {
    const reflectionClass = ReflectionClass.from(type);

    return Object.fromEntries(
      reflectionClass.getProperties().map(property => {
        let type = this.createOutputType(property.type);
        if (!property.isOptional() && !property.isNullable()) {
          type = new GraphQLNonNull(type);
        }

        return [property.name, { type }];
      }),
    ) as GraphQLFields<GraphQLInputType>;
  }

  createOutputObjectType(
    type: TypeObjectLiteral | TypeClass,
    extraFields?: GraphQLFields<GraphQLOutputType>,
  ): GraphQLObjectType {
    const name = requireTypeName(type);

    if (this.outputObjectTypes.has(name)) {
      return this.outputObjectTypes.get(name)!;
    }

    const objectType = new GraphQLObjectType({
      name,
      fields: () => {
        const fields = this.createOutputFields(type);
        return { ...fields, ...extraFields };
      },
    });
    this.outputObjectTypes.set(name, objectType);

    return objectType;
  }

  createInputObjectType(type: TypeObjectLiteral | TypeClass): GraphQLInputType {
    const name = requireTypeName(type);

    if (this.inputObjectTypes.has(name)) {
      return this.inputObjectTypes.get(name)!;
    }

    const inputObjectType = new GraphQLInputObjectType({
      name,
      fields: () => this.createInputFields(type),
    });
    this.inputObjectTypes.set(name, inputObjectType);

    return inputObjectType;
  }

  generateMutationResolverFields<T>(
    instance: T,
  ): GraphQLFieldConfigMap<unknown, unknown> {
    const { constructor } = instance as { readonly constructor: ClassType };
    const resolver = gqlResolverDecorator._fetch(constructor);
    if (!resolver) {
      throw new Error(
        `Missing @graphql.resolver() decorator on ${constructor.name}`,
      );
    }
    const resolverType = resolveRuntimeType(constructor);
    const reflectionClass = ReflectionClass.from(resolverType);

    const fields = new Map<string, GraphQLFieldConfig<unknown, unknown>>();

    // eslint-disable-next-line functional/no-loop-statement
    for (const [methodName, query] of resolver.mutations.entries()) {
      const reflectionMethod = reflectionClass.getMethod(methodName);

      const args = this.createInputArgsFromReflectionParameters(
        reflectionMethod.parameters,
      );

      const returnType = this.createReturnType(reflectionMethod.type.return);

      const resolve = createResolveFunction<T>(instance, reflectionMethod);

      fields.set(query.name, {
        type: returnType,
        description: query.description,
        deprecationReason: query.deprecationReason,
        args,
        resolve,
      });
    }

    return Object.fromEntries(fields.entries());
  }

  generateFieldResolver<T>(
    instance: T,
    fieldName: string,
  ): Pick<GraphQLFieldConfig<unknown, unknown>, 'args' | 'resolve'> {
    const { constructor } = instance as { readonly constructor: ClassType };
    const resolver = gqlResolverDecorator._fetch(constructor);
    if (!resolver) {
      throw new Error(
        `Missing @graphql.resolver<T>() decorator on ${constructor.name}`,
      );
    }
    const resolverType = resolveRuntimeType(constructor);
    const reflectionClass = ReflectionClass.from(resolverType);

    const field = [...resolver.resolveFields.values()].find(
      field => field.name === fieldName,
    );
    if (!field) {
      throw new Error(`Field ${fieldName} is missing`);
    }

    const reflectionMethod = reflectionClass.getMethod(field.property);

    // const returnType = createReturnType(reflectionMethod.type.return);

    const resolve = createResolveFunction<T>(instance, reflectionMethod);

    const args = this.createInputArgsFromReflectionParameters(
      reflectionMethod.parameters,
    );

    return {
      // validate that type is the same
      // type: returnType,
      args,
      resolve,
    };
  }

  generateQueryResolverFields<T>(
    instance: T,
  ): GraphQLFieldConfigMap<unknown, unknown> {
    const { constructor } = instance as { readonly constructor: ClassType };
    const resolver = gqlResolverDecorator._fetch(constructor);
    if (!resolver) {
      throw new Error(
        `Missing @graphql.resolver() decorator on ${constructor.name}`,
      );
    }
    const resolverType = resolveRuntimeType(constructor);
    const reflectionClass = ReflectionClass.from(resolverType);

    const fields = new Map<string, GraphQLFieldConfig<unknown, unknown>>();

    // eslint-disable-next-line functional/no-loop-statement
    for (const [methodName, query] of resolver.queries.entries()) {
      const reflectionMethod = reflectionClass.getMethod(methodName);

      const args = this.createInputArgsFromReflectionParameters(
        reflectionMethod.parameters,
      );

      const returnType = this.createReturnType(reflectionMethod.type.return);

      const resolve = createResolveFunction<T>(instance, reflectionMethod);

      fields.set(query.name, {
        type: returnType,
        description: query.description,
        deprecationReason: query.deprecationReason,
        args,
        resolve,
      });
    }

    return Object.fromEntries(fields.entries());
  }

  hasFieldResolver<T>(instance: T, fieldName: string): boolean {
    const { constructor } = instance as { readonly constructor: ClassType };
    const resolver = gqlResolverDecorator._fetch(constructor);
    if (!resolver) {
      throw new Error(
        `Missing @graphql.resolver() decorator on ${constructor.name}`,
      );
    }
    return [...resolver.resolveFields.values()].some(
      field => field.name === fieldName,
    );
  }
}
