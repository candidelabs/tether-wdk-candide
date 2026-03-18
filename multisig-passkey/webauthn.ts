/**
 * Simulated WebAuthn for Node.js demonstration.
 *
 * In a real browser application, replace this with the native
 * navigator.credentials API. The on-chain verification is identical —
 * the verifier contract validates P-256 signatures regardless of
 * whether they came from hardware or software.
 *
 * Adapted from:
 * https://github.com/candidelabs/abstractionkit-examples/blob/main/passkeys/webauthn.ts
 * https://github.com/safe-global/safe-modules/blob/main/modules/4337/test/utils/webauthn.ts
 */

import * as crypto from 'node:crypto'
import { keccak256, sha256, toHex, hexToBytes, toBytes, maxUint256, type Hex } from 'viem'
import CBOR from 'cbor'

export interface CredentialCreationOptions {
  publicKey: PublicKeyCredentialCreationOptions
}

export enum UserVerificationRequirement {
  'required',
  'preferred',
  'discouraged',
}

export interface PublicKeyCredentialCreationOptions {
  rp: { id: string; name: string }
  user: { id: Uint8Array; displayName: string; name: string }
  challenge: Uint8Array
  pubKeyCredParams: {
    type: 'public-key'
    alg: number
  }[]
  attestation?: 'none'
  userVerification?: Exclude<UserVerificationRequirement, UserVerificationRequirement.discouraged>
}

export interface CredentialRequestOptions {
  publicKey: PublicKeyCredentialRequestOptions
}

export interface PublicKeyCredentialRequestOptions {
  challenge: Uint8Array
  rpId: string
  allowCredentials: {
    type: 'public-key'
    id: Uint8Array
  }[]
  userVerification?: Exclude<UserVerificationRequirement, UserVerificationRequirement.discouraged>
  attestation?: 'none'
}

export interface PublicKeyCredential<AuthenticatorResponse> {
  type: 'public-key'
  id: string
  rawId: ArrayBuffer
  response: AuthenticatorResponse
}

export interface AuthenticatorAttestationResponse {
  clientDataJSON: ArrayBuffer
  attestationObject: ArrayBuffer
}

export interface AuthenticatorAssertionResponse {
  clientDataJSON: ArrayBuffer
  authenticatorData: ArrayBuffer
  signature: ArrayBuffer
  userHandle: ArrayBuffer
}

class Credential {
  public id: Hex
  public privateKey: crypto.KeyObject
  private publicKeyUncompressed: Uint8Array

  constructor(
    public rp: string,
    public user: Uint8Array,
  ) {
    const keyPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    this.privateKey = keyPair.privateKey

    const pubJwk = keyPair.publicKey.export({ format: 'jwk' })
    const x = Buffer.from(pubJwk.x!, 'base64url')
    const y = Buffer.from(pubJwk.y!, 'base64url')
    this.publicKeyUncompressed = new Uint8Array(Buffer.concat([Buffer.from([0x04]), x, y]))

    const pubKeyHash = keccak256(toHex(this.publicKeyUncompressed.slice(1)))
    this.id = `0x${pubKeyHash.slice(26)}` as Hex
  }

  public cosePublicKey(): Buffer {
    const x = this.publicKeyUncompressed.subarray(1, 33)
    const y = this.publicKeyUncompressed.subarray(33, 65)

    const key = new Map()
    key.set(-1, 1)
    key.set(-2, b2ab(x))
    key.set(-3, b2ab(y))
    key.set(1, 2)
    key.set(3, -7)
    return CBOR.encode(key)
  }
}

function buildAuthenticatorData(
  rpId: string,
  flags: number,
  signCount: number,
  attestedCredentialData?: Buffer,
): Buffer {
  const rpIdHash = Buffer.from(hexToBytes(sha256(toBytes(rpId))))
  const flagsBuf = Buffer.from([flags])
  const signCountBuf = Buffer.alloc(4)
  signCountBuf.writeUInt32BE(signCount)

  const parts: Buffer[] = [rpIdHash, flagsBuf, signCountBuf]
  if (attestedCredentialData) {
    parts.push(attestedCredentialData)
  }
  return Buffer.concat(parts)
}

export class WebAuthnCredentials {
  #credentials: Credential[] = []

  public create({ publicKey }: CredentialCreationOptions): PublicKeyCredential<AuthenticatorAttestationResponse> {
    if (!publicKey.pubKeyCredParams.some(({ alg }) => alg === -7)) {
      throw new Error('unsupported signature algorithm(s)')
    }

    const credential = new Credential(publicKey.rp.id, publicKey.user.id)
    this.#credentials.push(credential)

    const clientData = {
      type: 'webauthn.create',
      challenge: base64UrlEncode(publicKey.challenge).replace(/=*$/, ''),
      origin: `https://${publicKey.rp.id}`,
    }

    const userVerification = publicKey.userVerification ?? 'preferred'
    const uvFlag = userVerification === UserVerificationRequirement.required ? 0x04 : 0x00

    const aaguid = Buffer.alloc(16, 0x42)
    const credIdBytes = Buffer.from(hexToBytes(credential.id))
    const credIdLen = Buffer.alloc(2)
    credIdLen.writeUInt16BE(credIdBytes.length)
    const attestedCredentialData = Buffer.concat([aaguid, credIdLen, credIdBytes, credential.cosePublicKey()])

    const authData = buildAuthenticatorData(
      publicKey.rp.id,
      0x41 | uvFlag,
      0,
      attestedCredentialData,
    )

    const attestationObject = { authData, fmt: 'none', attStmt: {} }

    return {
      id: base64UrlEncode(credential.id),
      rawId: b2ab(hexToBytes(credential.id)),
      response: {
        clientDataJSON: b2ab(Buffer.from(JSON.stringify(clientData))),
        attestationObject: b2ab(CBOR.encode(attestationObject)),
      },
      type: 'public-key',
    }
  }

  get({ publicKey }: CredentialRequestOptions): PublicKeyCredential<AuthenticatorAssertionResponse> {
    const credential = publicKey.allowCredentials
      .flatMap(({ id }) => this.#credentials.filter((c) => c.rp === publicKey.rpId && c.id === toHex(id)))
      .at(0)
    if (credential === undefined) {
      throw new Error('credential not found')
    }

    const clientData = {
      type: 'webauthn.get',
      challenge: base64UrlEncode(publicKey.challenge).replace(/=*$/, ''),
      origin: `https://${publicKey.rpId}`,
    }

    const userVerification = publicKey.userVerification ?? 'preferred'
    const uvFlag = userVerification === UserVerificationRequirement.required ? 0x04 : 0x00

    const authenticatorData = buildAuthenticatorData(publicKey.rpId, 0x01 | uvFlag, 0)

    const clientDataHash = Buffer.from(hexToBytes(sha256(toBytes(JSON.stringify(clientData)))))
    const dataToSign = Buffer.concat([authenticatorData, clientDataHash])
    const derSignature = crypto.sign('sha256', dataToSign, credential.privateKey)

    return {
      id: base64UrlEncode(credential.id),
      rawId: b2ab(hexToBytes(credential.id)),
      response: {
        clientDataJSON: b2ab(Buffer.from(JSON.stringify(clientData))),
        authenticatorData: b2ab(authenticatorData),
        signature: b2ab(derSignature),
        userHandle: b2ab(credential.user),
      },
      type: 'public-key',
    }
  }
}

export function base64UrlEncode(data: Hex | Uint8Array | ArrayBufferLike): string {
  if (typeof data === 'string') {
    return Buffer.from(hexToBytes(data)).toString('base64url')
  }
  if (data instanceof Uint8Array) {
    return Buffer.from(data).toString('base64url')
  }
  return Buffer.from(new Uint8Array(data)).toString('base64url')
}

function b2ab(buf: Uint8Array): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

export function extractPublicKey(response: AuthenticatorAttestationResponse): { x: bigint; y: bigint } {
  const attestationObject = CBOR.decode(response.attestationObject)
  const authData: Buffer = attestationObject.authData
  const authDataView = new DataView(authData.buffer, authData.byteOffset, authData.byteLength)
  const credentialIdLength = authDataView.getUint16(53)
  const cosePublicKey = authData.subarray(55 + credentialIdLength)
  const key: Map<number, unknown> = CBOR.decode(cosePublicKey)
  const bn = (bytes: Uint8Array) => BigInt(toHex(bytes))
  return {
    x: bn(key.get(-2) as Uint8Array),
    y: bn(key.get(-3) as Uint8Array),
  }
}

export function extractClientDataFields(response: AuthenticatorAssertionResponse): string {
  const clientDataJSON = new TextDecoder('utf-8').decode(response.clientDataJSON)
  const match = clientDataJSON.match(/^\{"type":"webauthn.get","challenge":"[A-Za-z0-9\-_]{43}",(.*)\}$/)

  if (!match) {
    throw new Error('challenge not found in client data JSON')
  }

  const [, fields] = match
  return toHex(toBytes(fields))
}

export function extractSignature(response: AuthenticatorAssertionResponse): [bigint, bigint] {
  const check = (x: boolean) => {
    if (!x) {
      throw new Error('invalid signature encoding')
    }
  }

  const view = new DataView(response.signature)

  check(view.getUint8(0) === 0x30)
  check(view.getUint8(1) === view.byteLength - 2)

  const readInt = (offset: number) => {
    check(view.getUint8(offset) === 0x02)
    const len = view.getUint8(offset + 1)
    const start = offset + 2
    const end = start + len
    const n = BigInt(toHex(new Uint8Array(view.buffer.slice(start, end))))
    check(n < maxUint256)
    return [n, end] as const
  }
  const [r, sOffset] = readInt(2)
  const [s] = readInt(sOffset)

  return [r, s]
}
