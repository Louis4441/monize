import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Unique,
} from "typeorm";
import { ApiProperty } from "@nestjs/swagger";
import { Category } from "../../categories/entities/category.entity";
import { User } from "../../users/entities/user.entity";

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
