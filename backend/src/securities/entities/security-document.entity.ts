import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Security } from "./security.entity";

/**
 * What a document about a security is. Deliberately a short list of the things
 * an issuer actually publishes, plus OTHER: a long taxonomy nobody picks from
 * correctly is worse than a short one and a name field.
 */
export enum SecurityDocumentType {
  FACTSHEET = "FACTSHEET",
  KIID = "KIID",
  PROSPECTUS = "PROSPECTUS",
  ANNUAL_REPORT = "ANNUAL_REPORT",
  SEMI_ANNUAL_REPORT = "SEMI_ANNUAL_REPORT",
  TAX = "TAX",
  RESEARCH = "RESEARCH",
  OTHER = "OTHER",
}

@Entity("security_documents")
@Index(["securityId", "documentDate"])
export class SecurityDocument {
  @ApiProperty()
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @ApiProperty()
  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ApiProperty()
  @Column({ type: "uuid", name: "security_id" })
  securityId: string;

  @ApiProperty({ enum: SecurityDocumentType })
  @Column({
    type: "varchar",
    length: 30,
    name: "document_type",
    default: SecurityDocumentType.OTHER,
  })
  documentType: SecurityDocumentType;

  @ApiProperty({ example: "2024 Annual Report" })
  @Column({ type: "varchar", length: 255 })
  name: string;

  /**
   * The date printed on the document, not the day it was recorded: a 2024
   * annual report added today belongs under 2024. Null where the document
   * carries no date, which is common enough that guessing one would be worse.
   *
   * Stored as a string, per the project's DATE convention -- a Date parsed in
   * UTC can shift the day when read back.
   */
  @ApiPropertyOptional({ example: "2024-12-31" })
  @Column({
    type: "date",
    name: "document_date",
    nullable: true,
    transformer: {
      from: (value: string | Date | null): string | null => {
        if (!value) return value as null;
        if (typeof value === "string") return value;
        return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
      },
      to: (value: string | Date | null): string | Date | null => value,
    },
  })
  documentDate: string | null;

  @ApiProperty({ example: "https://www.ishares.com/factsheet.pdf" })
  @Column({ type: "varchar", length: 2048 })
  url: string;

  @ApiPropertyOptional()
  @Column({ type: "text", nullable: true })
  notes: string | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;

  @ManyToOne(() => Security, { onDelete: "CASCADE" })
  @JoinColumn({ name: "security_id" })
  security: Security;
}
