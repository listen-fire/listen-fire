import DataLoader from 'dataloader';

import { decode, encode } from '../lib/hashids';
import { findByIdDataloader, Models, ModelType } from '../lib/datasources/dataloaders';
import { currentContext } from './context';

type LoaderMap<
  T extends Record<string, () => DataLoader<unknown, unknown>> = Record<
    string,
    () => DataLoader<unknown, unknown>
  >,
> = {
  [K in keyof T]: ReturnType<T[K]>;
};

type LoaderGetterMap = Record<string, () => DataLoader<unknown, unknown>>;

// Use a Proxy to allow us to call arbitrary memoized dataloaders by property access
// Key bit here is that on `get` for any property, we invoke the memoized function
// We also provide "findById" dataloader automatically
const getDataloaderGettersForModel = function <U extends keyof Models>(objectName: U) {
  return function <T extends LoaderGetterMap>(
    loaderGetterMap: T & {
      findById?: () => DataLoader<string, ModelType<U> | null>;
    },
  ): LoaderMap<T & { findById: () => DataLoader<string, ModelType<U> | null> }> {
    loaderGetterMap.findById = findByIdDataloader(objectName);

    return new Proxy(loaderGetterMap, {
      get: (target, prop) => {
        if (prop in target) {
          return target[prop as keyof typeof target]();
        }
        return undefined;
      },
    }) as unknown as LoaderMap<
      T & {
        findById: () => DataLoader<string, ModelType<U> | null>;
      }
    >;
  };
};

abstract class ModelService<U extends keyof Models> {
  protected abstract objectName: U;

  protected get model() {
    const { prisma } = currentContext();
    return prisma[this.objectName];
  }

  private _dataloaders: LoaderMap | undefined;
  dataloaders: LoaderMap<{ findById: () => DataLoader<string, ModelType<U> | null> }>;

  constructor() {
    // alias `this` to use in the getter/setter for dataloaders
    const self = this; // eslint-disable-line @typescript-eslint/no-this-alias

    // definitively assign "dataloaders" in the constructor
    // to keep typescript happy
    this.dataloaders = {} as any; // eslint-disable-line @typescript-eslint/no-explicit-any

    // we're using a getter/setter here because:
    // - it defers the first call of "self.Loaders" until after the instantiation of the inheriting
    //   class (which is what assigns "this.objectName", which we need to set up findById)
    // - it allows us to override the dataloaders in the inheriting classes
    // see https://stackoverflow.com/questions/68477998/how-to-properly-override-an-accessor-getter-in-the-prototype-of-a-base-class-w
    Object.defineProperty(this, 'dataloaders', {
      get: () => {
        if (!self._dataloaders) {
          self._dataloaders = self.getDataloaderGetters({});
        }

        return self._dataloaders;
      },
      set: (dataloaders: LoaderMap) => {
        self._dataloaders = dataloaders;
      },
    });
  }

  // a version of the dataloader builder bound to the instance allows us to automatically
  // provide the right findById dataloader
  protected get getDataloaderGetters() {
    return getDataloaderGettersForModel(this.objectName);
  }

  async getById(id?: string): Promise<ModelType<U>> {
    if (!id) {
      throw new Error(`Missing ${this.objectName} ${id}`);
    }
    const record = await this.dataloaders.findById.load(id);
    if (!record) {
      throw new Error(`Could not find ${this.objectName} ${id}`);
    }
    return record;
  }

  hashIdEncode(num: number | bigint) {
    return encode(num, this.objectName);
  }

  hashIdDecode(encoded: string) {
    return decode(encoded, this.objectName);
  }
}

export { ModelService };
