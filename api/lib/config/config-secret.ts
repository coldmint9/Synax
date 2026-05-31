import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

const ENCRYPTED_PREFIX = 'enc:v1:'
const MASKED_SECRET = '****'

function encryptionKey(): Buffer {
  const raw = process.env.CONFIG_ENCRYPTION_KEY || process.env.Synax_CONFIG_SECRET || 'Synax-local-config-secret'
  return createHash('sha256').update(raw).digest()
}

export function isEncryptedSecret(value: string | undefined | null): boolean {
  return Boolean(value?.startsWith(ENCRYPTED_PREFIX))
}

export function encryptSecret(value: string | undefined | null): string | undefined {
  if (!value) return undefined
  if (isEncryptedSecret(value)) return value

  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${ENCRYPTED_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`
}

export function decryptSecret(value: string | undefined | null): string | undefined {
  if (!value) return undefined
  if (!isEncryptedSecret(value)) return value

  const payload = value.slice(ENCRYPTED_PREFIX.length)
  const [ivB64, tagB64, ciphertextB64] = payload.split(':')
  if (!ivB64 || !tagB64 || !ciphertextB64) return undefined

  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivB64, 'base64'))
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextB64, 'base64')),
      decipher.final(),
    ])
    return plaintext.toString('utf8')
  } catch {
    return undefined
  }
}

export function maskSecret(value: string | undefined | null): string | undefined {
  if (!value) return undefined

  const plain = isEncryptedSecret(value) ? decryptSecret(value) : value
  if (!plain) return MASKED_SECRET
  if (plain.length <= 8) return MASKED_SECRET
  return `${plain.slice(0, 4)}${MASKED_SECRET}${plain.slice(-4)}`
}
