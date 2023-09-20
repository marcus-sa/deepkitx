import { InjectorModule } from '@deepkit/injector';
import { ClassType } from '@deepkit/core';
import { GraphQLError, GraphQLFieldResolver } from 'graphql';
import {
  deserialize,
  metaAnnotation,
  ReflectionKind,
  ReflectionMethod,
  ReflectionParameter,
  serialize,
  serializer,
  TypeObjectLiteral,
  TypePropertySignature,
  validate,
  ValidationError,
} from '@deepkit/type';

import { CONTEXT_META_NAME, Instance, PARENT_META_NAME } from './types-builder';

export class DeepkitGraphQLResolvers extends Set<{
  readonly module: InjectorModule;
  readonly controller: ClassType;
}> {}

export class Resolvers extends WeakMap<ClassType, Instance> {
  readonly classTypes = new Set<ClassType>();

  readonly instances = new Set<Instance>();

  constructor(instances: readonly Instance[]) {
    const entries = instances.map<readonly [ClassType, Instance]>(instance => [
      instance.constructor,
      instance,
    ]);
    super(entries);
    entries.forEach(([classType]) => this.classTypes.add(classType));
    instances.forEach(instance => this.instances.add(instance));
  }
}

export function getParentMetaAnnotationReflectionParameterIndex(
  parameters: readonly ReflectionParameter[],
): number {
  return parameters.findIndex(
    ({ parameter }) =>
      metaAnnotation.getForName(parameter.type, PARENT_META_NAME) ||
      // FIXME: `Parent<T>` annotation is somehow not available in `example-graphql` app
      parameter.type.kind === ReflectionKind.unknown,
  );
}

export function getContextMetaAnnotationReflectionParameterIndex(
  parameters: readonly ReflectionParameter[],
): number {
  return parameters.findIndex(
    ({ parameter }) =>
      metaAnnotation.getForName(parameter.type, CONTEXT_META_NAME) ||
      // FIXME: `Context<T>` annotation is somehow not available in `example-graphql` app
      parameter.type.kind === ReflectionKind.unknown,
  );
}

export function filterReflectionParametersMetaAnnotationsForArguments(
  parameters: readonly ReflectionParameter[],
): readonly ReflectionParameter[] {
  const argsParameters = [...parameters];

  const parentIndex =
    getParentMetaAnnotationReflectionParameterIndex(argsParameters);

  if (parentIndex !== -1) {
    // eslint-disable-next-line functional/immutable-data
    argsParameters.splice(parentIndex, 1);
  }

  const contextIndex =
    getContextMetaAnnotationReflectionParameterIndex(argsParameters);

  if (contextIndex !== -1) {
    // eslint-disable-next-line functional/immutable-data
    argsParameters.splice(contextIndex, 1);
  }

  return argsParameters;
}

// eslint-disable-next-line functional/prefer-readonly-type
export function createResolveFunction<Resolver, Args extends unknown[] = []>(
  instance: Resolver,
  { parameters, name, type }: ReflectionMethod,
): GraphQLFieldResolver<unknown, unknown, Args> {
  // @ts-ignore
  const resolve = instance[name as keyof Resolver].bind(instance) as (
    ...args: Args
  ) => unknown;

  const argsParameters =
    filterReflectionParametersMetaAnnotationsForArguments(parameters);

  const argsType: TypeObjectLiteral = {
    kind: ReflectionKind.objectLiteral,
    types: [],
  };

  argsType.types = argsParameters.map<TypePropertySignature>(parameter => ({
    kind: ReflectionKind.propertySignature,
    parent: argsType,
    name: parameter.name,
    type: parameter.type,
  }));

  const parentParameterIndex =
    getParentMetaAnnotationReflectionParameterIndex(parameters);

  const contextParameterIndex =
    getContextMetaAnnotationReflectionParameterIndex(parameters);

  return async (parent, args, context) => {
    const argsValidationErrors = validate(args, argsType);
    if (argsValidationErrors.length) {
      const originalError = new ValidationError(argsValidationErrors);
      throw new GraphQLError(originalError.message, {
        originalError,
        path: [name],
      });
    }

    const resolveArgs = argsParameters.map(parameter =>
      deserialize(
        args[parameter.name as keyof Args],
        undefined,
        serializer,
        undefined,
        parameter.type,
      ),
    ) as Parameters<typeof resolve>;

    if (parentParameterIndex !== -1) {
      // eslint-disable-next-line functional/immutable-data
      resolveArgs.splice(parentParameterIndex, 0, parent);
    }

    if (contextParameterIndex !== -1) {
      // eslint-disable-next-line functional/immutable-data
      resolveArgs.splice(contextParameterIndex, 0, context);
    }

    const result = await resolve(...resolveArgs);

    return serialize(result, undefined, serializer, undefined, type.return);
  };
}
