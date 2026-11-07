import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { EngineError } from '../errors.js';
import type { AuthType } from '../manifest/types.js';
import { createId, isStringRecord, systemClock, type Clock } from '../util.js';

/**
 * Envelope encryption: every credential gets its own random data key
 * (AES-256-GCM). The data key is stored only wrapped by a master key that
 * lives in a KMS (or, for development, in an environment variable).
 * The database never sees a plaintext secret or an unwrapped key.
 */

export type SecretValues = Record<string, string>;

export type KeyProvider = {
  keyId: string;
  wrap: (dataKey: Buffer) => Promise<string>;
  unwrap: (wrappedKey: string, keyId: string) => Promise<Buffer>;
};

export type EncryptedCredential = {
  id: string;
  workspaceId: string;
  pluginId: string;
  authType: AuthType;
  keyId: string;
  wrappedKey: string;
  iv: string;
  authTag: string;
  ciphertext: string;
  fieldNames: string[];
  createdAt: number;
  updatedAt: number;
  expiresAt: number | undefined;
  errored: boolean;
};

export type SecretRepository = {
  save: (record: EncryptedCredential) => Promise<void>;
  find: (id: string) => Promise<EncryptedCredential | undefined>;
  delete: (id: string) => Promise<void>;
  listByWorkspace: (workspaceId: string) => Promise<EncryptedCredential[]>;
};

export type CredentialStatus = 'connected' | 'expired' | 'error';

/** What the browser and the 3D node may see about a credential: never its values. */
export type CredentialInfo = {
  id: string;
  workspaceId: string;
  pluginId: string;
  authType: AuthType;
  status: CredentialStatus;
  fieldNames: string[];
  createdAt: number;
  updatedAt: number;
  expiresAt: number | undefined;
};

export type PutCredentialInput = {
  workspaceId: string;
  pluginId: string;
  authType: AuthType;
  values: SecretValues;
  expiresAt?: number;
};

export type SecretStore = {
  put: (input: PutCredentialInput) => Promise<CredentialInfo>;
  replace: (id: string, values: SecretValues, expiresAt?: number) => Promise<CredentialInfo>;
  /** Backend-only: decrypts a credential for the workspace that owns it. */
  reveal: (id: string, workspaceId: string) => Promise<SecretValues>;
  info: (id: string) => Promise<CredentialInfo | undefined>;
  list: (workspaceId: string) => Promise<CredentialInfo[]>;
  markError: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
};

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

const sealBytes = (key: Buffer, plaintext: Buffer, aad?: Buffer) => {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  if (aad) cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, ciphertext, authTag: cipher.getAuthTag() };
};

const openBytes = (key: Buffer, iv: Buffer, ciphertext: Buffer, authTag: Buffer, aad?: Buffer): Buffer => {
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
};

/** Development key provider. In production, implement KeyProvider with your cloud KMS. */
export const createLocalKeyProvider = (masterKey: Buffer, keyId = 'local-1'): KeyProvider => {
  if (masterKey.length !== KEY_BYTES) throw new EngineError('SECURITY', `Master key must be ${KEY_BYTES} bytes`);
  return {
    keyId,
    wrap: async (dataKey) => {
      const { iv, ciphertext, authTag } = sealBytes(masterKey, dataKey);
      return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
    },
    unwrap: async (wrappedKey, requestedKeyId) => {
      if (requestedKeyId !== keyId) throw new EngineError('SECURITY', `Unknown key id ${requestedKeyId}`);
      const packed = Buffer.from(wrappedKey, 'base64');
      return openBytes(masterKey, packed.subarray(0, IV_BYTES), packed.subarray(IV_BYTES + 16), packed.subarray(IV_BYTES, IV_BYTES + 16));
    },
  };
};

export const createInMemorySecretRepository = (): SecretRepository => {
  const records = new Map<string, EncryptedCredential>();
  return {
    save: async (record) => {
      records.set(record.id, structuredClone(record));
    },
    find: async (id) => {
      const record = records.get(id);
      return record ? structuredClone(record) : undefined;
    },
    delete: async (id) => {
      records.delete(id);
    },
    listByWorkspace: async (workspaceId) =>
      [...records.values()].filter((record) => record.workspaceId === workspaceId).map((record) => structuredClone(record)),
  };
};

export type SecretStoreOptions = {
  keyProvider: KeyProvider;
  repository: SecretRepository;
  clock?: Clock;
};

export const createSecretStore = ({ keyProvider, repository, clock = systemClock }: SecretStoreOptions): SecretStore => {
  // Binding the ciphertext to its owner means a copied row cannot be decrypted under another workspace.
  const associatedData = (record: Pick<EncryptedCredential, 'id' | 'workspaceId' | 'pluginId'>) =>
    Buffer.from(`${record.id}:${record.workspaceId}:${record.pluginId}`);

  const encrypt = async (record: Pick<EncryptedCredential, 'id' | 'workspaceId' | 'pluginId'>, values: SecretValues) => {
    const dataKey = randomBytes(KEY_BYTES);
    try {
      const { iv, ciphertext, authTag } = sealBytes(dataKey, Buffer.from(JSON.stringify(values)), associatedData(record));
      return {
        keyId: keyProvider.keyId,
        wrappedKey: await keyProvider.wrap(dataKey),
        iv: iv.toString('base64'),
        authTag: authTag.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      };
    } finally {
      dataKey.fill(0);
    }
  };

  const decrypt = async (record: EncryptedCredential): Promise<SecretValues> => {
    const dataKey = await keyProvider.unwrap(record.wrappedKey, record.keyId);
    try {
      const plaintext = openBytes(
        dataKey,
        Buffer.from(record.iv, 'base64'),
        Buffer.from(record.ciphertext, 'base64'),
        Buffer.from(record.authTag, 'base64'),
        associatedData(record),
      );
      const parsed: unknown = JSON.parse(plaintext.toString('utf8'));
      if (!isStringRecord(parsed)) throw new EngineError('SECURITY', 'Credential payload is corrupted');
      return parsed;
    } catch (error) {
      if (error instanceof EngineError) throw error;
      throw new EngineError('SECURITY', 'Credential could not be decrypted (tampered or wrong key)');
    } finally {
      dataKey.fill(0);
    }
  };

  const toInfo = (record: EncryptedCredential): CredentialInfo => ({
    id: record.id,
    workspaceId: record.workspaceId,
    pluginId: record.pluginId,
    authType: record.authType,
    status: record.errored ? 'error' : record.expiresAt !== undefined && record.expiresAt <= clock.now() ? 'expired' : 'connected',
    fieldNames: [...record.fieldNames],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
  });

  const findOrThrow = async (id: string): Promise<EncryptedCredential> => {
    const record = await repository.find(id);
    if (!record) throw new EngineError('NOT_FOUND', `Credential ${id} does not exist`);
    return record;
  };

  return {
    put: async ({ workspaceId, pluginId, authType, values, expiresAt }) => {
      const id = createId('cred');
      const now = clock.now();
      const record: EncryptedCredential = {
        id,
        workspaceId,
        pluginId,
        authType,
        ...(await encrypt({ id, workspaceId, pluginId }, values)),
        fieldNames: Object.keys(values).sort(),
        createdAt: now,
        updatedAt: now,
        expiresAt,
        errored: false,
      };
      await repository.save(record);
      return toInfo(record);
    },

    replace: async (id, values, expiresAt) => {
      const existing = await findOrThrow(id);
      const record: EncryptedCredential = {
        ...existing,
        ...(await encrypt(existing, values)),
        fieldNames: Object.keys(values).sort(),
        updatedAt: clock.now(),
        expiresAt,
        errored: false,
      };
      await repository.save(record);
      return toInfo(record);
    },

    reveal: async (id, workspaceId) => {
      const record = await findOrThrow(id);
      if (record.workspaceId !== workspaceId) throw new EngineError('PERMISSION', `Credential ${id} belongs to another workspace`);
      return decrypt(record);
    },

    info: async (id) => {
      const record = await repository.find(id);
      return record ? toInfo(record) : undefined;
    },

    list: async (workspaceId) => (await repository.listByWorkspace(workspaceId)).map(toInfo),

    markError: async (id) => {
      const record = await findOrThrow(id);
      await repository.save({ ...record, errored: true, updatedAt: clock.now() });
    },

    remove: async (id) => {
      await repository.delete(id);
    },
  };
};
