import { EngineError, ValidationError } from '../errors.js';
import { createInMemoryCategoryStore, defaultCategoryRecords, type CategoryStore } from './stores.js';

export { DEFAULT_CATEGORIES, type Category } from './category-data.js';
import type { Category } from './category-data.js';

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type CategoryInput = { slug: string; name: string; icon?: string };
export type CategoryPatch = { name?: string; icon?: string; sortOrder?: number };

export type CategoryRegistry = {
  list: () => Promise<Category[]>;
  get: (slug: string) => Promise<Category | undefined>;
  has: (slug: string) => Promise<boolean>;
  add: (input: CategoryInput) => Promise<Category>;
  update: (slug: string, patch: CategoryPatch) => Promise<Category>;
  remove: (slug: string, options: { isInUse: (slug: string) => Promise<boolean> | boolean }) => Promise<void>;
  /** Inserts any missing built-in category; safe to run at every boot. */
  ensureDefaults: () => Promise<void>;
};

const assertName = (name: string): void => {
  if (name.trim() === '') throw new ValidationError('Invalid category', [{ path: '$.name', message: 'must not be empty' }]);
};

export const createCategoryRegistry = (options: { store?: CategoryStore } = {}): CategoryRegistry => {
  const store = options.store ?? createInMemoryCategoryStore();

  const getOrThrow = async (slug: string) => {
    const category = await store.get(slug);
    if (!category) throw new EngineError('NOT_FOUND', `Category "${slug}" does not exist`);
    return category;
  };

  return {
    list: async () => (await store.list()).sort((a, b) => a.sortOrder - b.sortOrder),
    get: (slug) => store.get(slug),
    has: async (slug) => (await store.get(slug)) !== undefined,

    add: async ({ slug, name, icon }) => {
      if (!SLUG_PATTERN.test(slug)) throw new ValidationError('Invalid category', [{ path: '$.slug', message: 'must be kebab-case' }]);
      assertName(name);
      const existing = await store.list();
      const category: Category = { slug, name, icon, sortOrder: existing.length, isSystem: false };
      await store.insert(category);
      return category;
    },

    update: async (slug, patch) => {
      const category = await getOrThrow(slug);
      if (patch.name !== undefined) assertName(patch.name);
      const updated: Category = {
        ...category,
        name: patch.name ?? category.name,
        icon: patch.icon ?? category.icon,
        sortOrder: patch.sortOrder ?? category.sortOrder,
      };
      await store.update(updated);
      return updated;
    },

    remove: async (slug, { isInUse }) => {
      const category = await getOrThrow(slug);
      if (category.isSystem) throw new EngineError('CONFLICT', `System category "${slug}" cannot be removed`);
      if (await isInUse(slug)) throw new EngineError('CONFLICT', `Category "${slug}" is still used by plugins`);
      await store.delete(slug);
    },

    ensureDefaults: async () => {
      const existing = new Set((await store.list()).map((category) => category.slug));
      for (const category of defaultCategoryRecords()) {
        if (existing.has(category.slug)) continue;
        try {
          await store.insert(category);
        } catch (error) {
          // Another instance seeded it at the same moment.
          if (!(error instanceof EngineError && error.code === 'CONFLICT')) throw error;
        }
      }
    },
  };
};
