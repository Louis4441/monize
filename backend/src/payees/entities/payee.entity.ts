import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Unique,
} from "typeorm";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Exclude } from "class-transformer";
import { Category } from "../../categories/entities/category.entity";
import { User } from "../../users/entities/user.entity";

// `numeric` comes back from pg as a string to preserve precision; coordinates
// are consumed as numbers by the map math, so convert at the boundary.
const numericTransformer = {
  to: (value: number | null): number | null => value,
  from: (value: string | null): number | null =>
    value === null ? null : Number(value),
};

@Entity("payees")
@Unique(["userId", "name"])
export class Payee {
  @ApiProperty({ example: "c5f5d5f0-1234-4567-890a-123456789abc" })
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @ApiProperty({ example: "user-uuid" })
  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: "user_id" })
  user?: User;

  @ApiProperty({ example: "Starbucks", description: "Name of the payee" })
  @Column({ type: "varchar", length: 255 })
  name: string;

  @ApiProperty({
    example: "category-uuid",
    required: false,
    description: "Default category for transactions with this payee",
  })
  @Column({ type: "uuid", name: "default_category_id", nullable: true })
  defaultCategoryId: string | null;

  @ApiProperty({ example: "Local coffee shop on Main Street", required: false })
  @Column({ type: "text", nullable: true })
  notes: string;

  /**
   * The payee's site. Stored absolute so it can go straight into an anchor:
   * a schemeless address would be resolved relative to the current page.
   */
  @ApiProperty({ example: "https://www.starbucks.com", required: false })
  @Column({ type: "varchar", length: 2048, nullable: true })
  website: string | null;

  // Cached favicon bytes. Never selected by default and never serialized to the
  // client -- the bytes are served only through GET /payees/:id/logo.
  @Exclude()
  @Column({ type: "bytea", name: "logo_data", nullable: true, select: false })
  logoData: Buffer | null;

  @Exclude()
  @Column({
    type: "varchar",
    name: "logo_content_type",
    length: 100,
    nullable: true,
    select: false,
  })
  logoContentType: string | null;

  @ApiProperty({
    example: true,
    description: "Whether a cached brand logo is available",
  })
  @Column({ type: "boolean", name: "has_logo", default: false })
  hasLogo: boolean;

  @ApiPropertyOptional()
  @Column({ type: "timestamp", name: "logo_fetched_at", nullable: true })
  logoFetchedAt: Date | null;

  /**
   * Free-text postal address. One field rather than structured parts: formats
   * are locale-specific and the geocoder takes a single query string.
   */
  @ApiPropertyOptional({ example: "1912 Pike Pl, Seattle, WA 98101" })
  @Column({ type: "text", nullable: true })
  address: string | null;

  @ApiPropertyOptional({ example: "hello@starbucks.com" })
  @Column({ type: "varchar", length: 255, nullable: true })
  email: string | null;

  @ApiPropertyOptional({ example: "+1 206-448-8762" })
  @Column({ type: "varchar", length: 50, nullable: true })
  phone: string | null;

  // Where `address` resolved to, looked up server-side so the browser never
  // contacts a geocoder itself. Null when the address has not been located.
  @ApiPropertyOptional({ example: 47.60972 })
  @Column({
    type: "numeric",
    precision: 9,
    scale: 6,
    nullable: true,
    transformer: numericTransformer,
  })
  latitude: number | null;

  @ApiPropertyOptional({ example: -122.342201 })
  @Column({
    type: "numeric",
    precision: 9,
    scale: 6,
    nullable: true,
    transformer: numericTransformer,
  })
  longitude: number | null;

  /**
   * When the address was last looked up -- successful or not, the way
   * logoFetchedAt stamps the last icon attempt. Null means never looked up (no
   * address, or it was cleared); set with a null latitude means the lookup ran
   * and found nothing, which is what lets the UI offer a retry rather than
   * silently showing no map.
   */
  @ApiPropertyOptional()
  @Column({ type: "timestamp", name: "geocoded_at", nullable: true })
  geocodedAt: Date | null;

  @ApiProperty({ example: true, description: "Whether the payee is active" })
  @Column({ type: "boolean", name: "is_active", default: true })
  isActive: boolean;

  @ManyToOne(() => Category, { nullable: true })
  @JoinColumn({ name: "default_category_id" })
  defaultCategory: Category;

  @ApiProperty()
  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;
}
