import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { encrypt, decrypt } from "../auth/crypto.util";

@Injectable()
export class AiEncryptionService {
  private readonly encryptionKey: string;

  constructor(private readonly configService: ConfigService) {
    this.encryptionKey = this.configService.get<string>(
      "AI_ENCRYPTION_KEY",
      "",
    );
  }

  isConfigured(): boolean {
    return this.encryptionKey.length >= 32;
  }

  encrypt(plaintext: string): string {
    if (!this.isConfigured()) {
      throw new Error(
        "AI_ENCRYPTION_KEY is not configured or too short (minimum 32 characters)",
      );
    }
    return encrypt(plaintext, this.encryptionKey);
  }

  decrypt(ciphertext: string): string {
    if (!this.isConfigured()) {
      throw new Error(
        "AI_ENCRYPTION_KEY is not configured or too short (minimum 32 characters)",
      );
    }
    return decrypt(ciphertext, this.encryptionKey);
  }

  /**
   * Whether a stored ciphertext can still be read on this instance.
   *
   * Three states, not two, and the caller has to be able to tell them apart:
   * nothing stored, stored and readable, stored and unreadable. The last is what
   * a backup restored onto an instance with a different `AI_ENCRYPTION_KEY`
   * leaves behind -- the column is non-null, so every "is a key configured?"
   * check says yes, and only the provider call finds out otherwise. AES-GCM
   * authenticates, so a wrong key raises rather than returning plausible bytes;
   * that is what makes this answerable at all.
   *
   * Not cheap: `decrypt` derives its key with `scryptSync`, tens of milliseconds
   * per call by design. Fine on a restore or a connection test, wrong on a list
   * endpoint -- do not put it in a loop over a page of rows.
   */
  canDecrypt(ciphertext: string | null | undefined): boolean {
    if (!ciphertext) return false;
    if (!this.isConfigured()) return false;
    try {
      this.decrypt(ciphertext);
      return true;
    } catch {
      return false;
    }
  }

  maskApiKey(apiKey: string | null): string | null {
    if (!apiKey) return null;
    if (apiKey.length <= 4) return "****";
    return "****" + apiKey.slice(-4);
  }
}
