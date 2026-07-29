import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from "typeorm";
import { Exclude } from "class-transformer";
import { User } from "../../../users/entities/user.entity";

/**
 * A binary import file parked between the wizard's parse/preview call and the
 * background import job.
 *
 * The bytes are the **decrypted** Money file: the user's password is a
 * request-scoped multipart field on the parse call and is never persisted, so a
 * staged row can never leak it. The import re-parses these bytes rather than
 * storing a serialized intermediate representation, which keeps the preview and
 * the import provably in agreement (design ADR-2).
 *
 * `data` is `select: false` and `@Exclude()`d: a metadata lookup on a 200 MB
 * file must not pull the file into memory, and the bytes never reach a client.
 */
@Entity("import_staged_files")
export class ImportStagedFile {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user?: User;

  @Column({ type: "varchar", length: 255 })
  filename: string;

  /** Which importer staged this file. Only "mny" exists today. */
  @Column({
    type: "varchar",
    name: "source_format",
    length: 20,
    default: "mny",
  })
  sourceFormat: string;

  @Column({
    type: "bigint",
    name: "size_bytes",
    // BIGINT arrives from the pg driver as a string; the wizard compares it
    // against the configured size limit as a number.
    transformer: {
      to: (value: number | null): number | null => value,
      from: (value: string | null): number | null =>
        value === null ? null : Number(value),
    },
  })
  sizeBytes: number;

  /** Hex digest of the staged bytes: integrity, and a stable retry identity. */
  @Column({ type: "char", length: 64 })
  sha256: string;

  @Exclude()
  @Column({ type: "bytea", select: false })
  data: Buffer;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  /** When the TTL sweep may delete this row. */
  @Column({ type: "timestamp", name: "expires_at" })
  expiresAt: Date;
}
