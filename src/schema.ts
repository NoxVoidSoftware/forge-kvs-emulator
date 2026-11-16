/**
 * Custom Entity schema: what `app.storage.entities` in manifest.yml declares.
 *
 * The schema is validated against the documented Forge limits when the
 * emulator is created, so a manifest mistake fails the test suite instead of
 * the deployment.
 */

import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { EmulatorConfigError } from './errors.js';

export type AttributeType = 'string' | 'integer' | 'float' | 'boolean' | 'any';

export interface AttributeDefinition {
  type: AttributeType;
}

/** An index as written in the manifest: a bare attribute name, or a named index. */
export type ManifestIndex =
  | string
  | {
      name: string;
      partition?: string[];
      range?: string[] | string;
    };

/** One entry of `app.storage.entities` in manifest.yml. */
export interface EntityDefinition {
  name: string;
  attributes: Record<string, AttributeDefinition>;
  indexes?: ManifestIndex[];
}

export interface IndexDefinition {
  name: string;
  partition: string[];
  /** Attribute the index is sorted and filtered by (`where`). */
  range: string | undefined;
}

export interface EntitySchema {
  name: string;
  attributes: Map<string, AttributeType>;
  indexes: Map<string, IndexDefinition>;
}

export type Schema = Map<string, EntitySchema>;

const TYPES: AttributeType[] = ['string', 'integer', 'float', 'boolean', 'any'];
const ATTRIBUTE_NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;
const ENTITY_NAME = /^(?![-_.])(?!.*\.\.)[a-z0-9:\-_.]{3,60}(?<!\.)$/;
const INDEX_NAME = /^[a-zA-Z0-9:\-_.]{3,50}$/;

/** Documented Forge limits for entity definitions. */
export const SCHEMA_LIMITS = {
  maxEntities: 20,
  maxAttributes: 50,
  maxIndexes: 7,
  maxAttributeNameLength: 30
} as const;

/** Reads `app.storage.entities` from a manifest.yml file. */
export function loadManifestEntities(manifestPath: string): EntityDefinition[] {
  let manifest: unknown;
  try {
    manifest = parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new EmulatorConfigError(`Could not read the manifest at ${manifestPath}: ${(error as Error).message}`);
  }
  return entitiesFromManifest(manifest);
}

/** Extracts `app.storage.entities` from a parsed manifest object. */
export function entitiesFromManifest(manifest: unknown): EntityDefinition[] {
  const entities = (manifest as { app?: { storage?: { entities?: unknown } } } | null)?.app?.storage?.entities;
  if (entities === undefined) return [];
  if (!Array.isArray(entities)) throw new EmulatorConfigError('app.storage.entities must be a list');
  return entities as EntityDefinition[];
}

function fail(entity: string, message: string): never {
  throw new EmulatorConfigError(`Entity "${entity}": ${message}`);
}

/** Validates entity definitions and builds the lookup structure. */
export function buildSchema(definitions: EntityDefinition[]): Schema {
  if (definitions.length > SCHEMA_LIMITS.maxEntities) {
    throw new EmulatorConfigError(
      `An app can declare at most ${SCHEMA_LIMITS.maxEntities} entities (found ${definitions.length})`
    );
  }
  const schema: Schema = new Map();

  for (const definition of definitions) {
    const name = definition?.name;
    if (typeof name !== 'string' || !ENTITY_NAME.test(name)) {
      throw new EmulatorConfigError(`Invalid entity name ${JSON.stringify(name)} (3-60 characters: a-z 0-9 : - _ .)`);
    }
    if (schema.has(name)) fail(name, 'declared twice');

    const rawAttributes = definition.attributes ?? {};
    const attributeNames = Object.keys(rawAttributes);
    if (attributeNames.length === 0) fail(name, 'declares no attributes');
    if (attributeNames.length > SCHEMA_LIMITS.maxAttributes) {
      fail(name, `declares ${attributeNames.length} attributes; the limit is ${SCHEMA_LIMITS.maxAttributes}`);
    }
    const attributes = new Map<string, AttributeType>();
    for (const attribute of attributeNames) {
      if (!ATTRIBUTE_NAME.test(attribute) || attribute.length > SCHEMA_LIMITS.maxAttributeNameLength) {
        fail(
          name,
          `invalid attribute name "${attribute}" (letters, digits, _; at most ${SCHEMA_LIMITS.maxAttributeNameLength} characters)`
        );
      }
      const type = rawAttributes[attribute]?.type;
      if (!type || !TYPES.includes(type))
        fail(name, `attribute "${attribute}" has unknown type ${JSON.stringify(type)}`);
      attributes.set(attribute, type);
    }

    const rawIndexes = definition.indexes ?? [];
    if (rawIndexes.length > SCHEMA_LIMITS.maxIndexes) {
      fail(name, `declares ${rawIndexes.length} indexes; the limit is ${SCHEMA_LIMITS.maxIndexes}`);
    }
    const indexes = new Map<string, IndexDefinition>();
    for (const raw of rawIndexes) {
      const index: IndexDefinition =
        typeof raw === 'string'
          ? { name: raw, partition: [], range: raw }
          : {
              name: raw?.name,
              partition: raw?.partition ?? [],
              range: Array.isArray(raw?.range) ? raw.range[0] : raw?.range
            };
      if (typeof raw !== 'string' && Array.isArray(raw?.range) && raw.range.length > 1) {
        fail(name, `index "${index.name}" may have only one range attribute`);
      }
      // A simple index is named after its attribute; only named indexes follow the index name rules.
      if (typeof raw !== 'string' && (typeof index.name !== 'string' || !INDEX_NAME.test(index.name))) {
        fail(name, `invalid index name ${JSON.stringify(index.name)}`);
      }
      if (indexes.has(index.name)) fail(name, `index "${index.name}" declared twice`);
      for (const attribute of [...index.partition, ...(index.range ? [index.range] : [])]) {
        const type = attributes.get(attribute);
        if (!type) fail(name, `index "${index.name}" uses undeclared attribute "${attribute}"`);
        if (type === 'any')
          fail(name, `index "${index.name}" uses attribute "${attribute}" of type any, which cannot be indexed`);
      }
      indexes.set(index.name, index);
    }

    schema.set(name, { name, attributes, indexes });
  }
  return schema;
}
