#!/usr/bin/env python3
"""兼容 CryptoJS AES(passphrase) / OpenSSL Salted__ 格式的本地加解密脚本。"""

import argparse
import base64
import hashlib
import os
import secrets
import sys
from typing import Tuple

try:
    from Crypto.Cipher import AES
except ImportError as exc:
    print("❌ 缺少依赖 pycryptodome，请先安装：pip install pycryptodome", file=sys.stderr)
    raise SystemExit(1) from exc

BLOCK_SIZE = 16
MAGIC = b"Salted__"


def evp_bytes_to_key(passphrase: bytes, salt: bytes, key_len: int = 32, iv_len: int = 16) -> Tuple[bytes, bytes]:
    """复现 CryptoJS/OpenSSL 的 EVP_BytesToKey(MD5) 派生逻辑。"""
    output = b""
    digest = b""
    while len(output) < key_len + iv_len:
        digest = hashlib.md5(digest + passphrase + salt).digest()
        output += digest
    return output[:key_len], output[key_len:key_len + iv_len]


def pkcs7_pad(data: bytes) -> bytes:
    pad_len = BLOCK_SIZE - (len(data) % BLOCK_SIZE)
    return data + bytes([pad_len]) * pad_len


def pkcs7_unpad(data: bytes) -> bytes:
    if not data:
        raise ValueError("空数据，无法去除填充")
    pad_len = data[-1]
    if pad_len < 1 or pad_len > BLOCK_SIZE:
        raise ValueError("填充非法，密钥可能错误")
    if data[-pad_len:] != bytes([pad_len]) * pad_len:
        raise ValueError("填充校验失败，密钥可能错误")
    return data[:-pad_len]


def encrypt_text(plain_text: str, passphrase: str) -> str:
    salt = secrets.token_bytes(8)
    key, iv = evp_bytes_to_key(passphrase.encode("utf-8"), salt)
    cipher = AES.new(key, AES.MODE_CBC, iv)
    encrypted = cipher.encrypt(pkcs7_pad(plain_text.encode("utf-8")))
    return base64.b64encode(MAGIC + salt + encrypted).decode("utf-8")


def decrypt_text(cipher_text: str, passphrase: str) -> str:
    raw = base64.b64decode(cipher_text)
    if not raw.startswith(MAGIC):
        raise ValueError("密文不是受支持的 Salted__ 格式")
    salt = raw[8:16]
    encrypted = raw[16:]
    key, iv = evp_bytes_to_key(passphrase.encode("utf-8"), salt)
    cipher = AES.new(key, AES.MODE_CBC, iv)
    plain = cipher.decrypt(encrypted)
    return pkcs7_unpad(plain).decode("utf-8")


def get_key(args: argparse.Namespace) -> str:
    key = args.key or os.environ.get("SHARED_SECRET_CRYPTO_KEY")
    if not key:
        raise ValueError("未提供共享密钥；请使用 --key 或设置 SHARED_SECRET_CRYPTO_KEY")
    return key


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="CryptoJS AES(passphrase) / OpenSSL Salted__ 兼容加解密")
    subparsers = parser.add_subparsers(dest="command", required=True)

    decrypt_parser = subparsers.add_parser("decrypt", help="解密密文")
    decrypt_parser.add_argument("--cipher", required=True, help="Base64 密文，例如 U2FsdGVkX1...")
    decrypt_parser.add_argument("--key", help="共享密钥；未提供时读取 SHARED_SECRET_CRYPTO_KEY")

    encrypt_parser = subparsers.add_parser("encrypt", help="加密明文")
    encrypt_parser.add_argument("--text", required=True, help="待加密的明文")
    encrypt_parser.add_argument("--key", help="共享密钥；未提供时读取 SHARED_SECRET_CRYPTO_KEY")

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    try:
        key = get_key(args)
        if args.command == "decrypt":
            print(decrypt_text(args.cipher, key))
        elif args.command == "encrypt":
            print(encrypt_text(args.text, key))
        else:
            parser.error("未知命令")
        return 0
    except Exception as exc:
        print(f"❌ {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
