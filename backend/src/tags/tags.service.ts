import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
} from "@nestjs/common";
import { tr } from "../i18n/translate";
import { DataSource, EntityManager, QueryRunner, In } from "typeorm";
import { Tag } from "./entities/tag.entity";
import { TransactionTag } from "./entities/transaction-tag.entity";
import { TransactionSplitTag } from "./entities/transaction-split-tag.entity";
import { CreateTagDto } from "./dto/create-tag.dto";
import { UpdateTagDto } from "./dto/update-tag.dto";
import { ActionHistoryService } from "../action-history/action-history.service";
import { tenantTx } from "../common/db/tenant-tx";

@Injectable()
export class TagsService {
  private readonly logger = new Logger(TagsService.name);

  constructor(
    private dataSource: DataSource,
    private actionHistoryService: ActionHistoryService,
  ) {}

  async findAll(userId: string): Promise<Tag[]> {
    return tenantTx(this.dataSource, (m) =>
      m.getRepository(Tag).find({
        where: { userId },
        order: { name: "ASC" },
      }),
    );
  }

  async findOne(userId: string, id: string): Promise<Tag> {
    const tag = await tenantTx(this.dataSource, (m) =>
      m.getRepository(Tag).findOne({
        where: { id, userId },
      }),
    );
    if (!tag) {
      throw new NotFoundException(
        tr("errors.tags.notFound", `Tag with ID ${id} not found`, { id }),
      );
    }
    return tag;
  }

  private async findConflictingName(
    m: EntityManager,
    userId: string,
    name: string,
    excludeId?: string,
  ): Promise<Tag | null> {
    const qb = m
      .getRepository(Tag)
      .createQueryBuilder("tag")
      .where("tag.userId = :userId", { userId })
      .andWhere("LOWER(tag.name) = LOWER(:name)", { name });
    if (excludeId) {
      qb.andWhere("tag.id != :id", { id: excludeId });
    }
    return qb.getOne();
  }

  async create(userId: string, dto: CreateTagDto): Promise<Tag> {
    const saved = await tenantTx(this.dataSource, async (m) => {
      const existing = await this.findConflictingName(m, userId, dto.name);
      if (existing) {
        throw new ConflictException(
          tr(
            "errors.tags.nameConflict",
            `A tag named "${dto.name}" already exists`,
            { name: dto.name },
          ),
        );
      }

      const repo = m.getRepository(Tag);
      const tag = repo.create({
        ...dto,
        color: dto.color || null,
        icon: dto.icon || null,
        userId,
      });
      return repo.save(tag);
    });

    this.actionHistoryService.record(userId, {
      entityType: "tag",
      entityId: saved.id,
      action: "create",
      afterData: {
        id: saved.id,
        name: saved.name,
        color: saved.color,
        icon: saved.icon,
      },
      description: `Created tag "${saved.name}"`,
      descriptionKey: "createdTag",
      descriptionParams: { name: saved.name },
    });
    return saved;
  }

  async update(userId: string, id: string, dto: UpdateTagDto): Promise<Tag> {
    const tag = await this.findOne(userId, id);
    const beforeData = { name: tag.name, color: tag.color, icon: tag.icon };

    const saved = await tenantTx(this.dataSource, async (m) => {
      if (dto.name && dto.name.toLowerCase() !== tag.name.toLowerCase()) {
        const existing = await this.findConflictingName(
          m,
          userId,
          dto.name,
          id,
        );
        if (existing) {
          throw new ConflictException(
            tr(
              "errors.tags.nameConflict",
              `A tag named "${dto.name}" already exists`,
              { name: dto.name },
            ),
          );
        }
      }

      Object.assign(tag, {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.color !== undefined && { color: dto.color || null }),
        ...(dto.icon !== undefined && { icon: dto.icon || null }),
      });

      return m.getRepository(Tag).save(tag);
    });

    this.actionHistoryService.record(userId, {
      entityType: "tag",
      entityId: id,
      action: "update",
      beforeData,
      afterData: { name: saved.name, color: saved.color, icon: saved.icon },
      description: `Updated tag "${saved.name}"`,
      descriptionKey: "updatedTag",
      descriptionParams: { name: saved.name },
    });
    return saved;
  }

  async remove(userId: string, id: string): Promise<void> {
    const tag = await this.findOne(userId, id);
    const beforeData = {
      id: tag.id,
      name: tag.name,
      color: tag.color,
      icon: tag.icon,
    };
    await tenantTx(this.dataSource, (m) => m.getRepository(Tag).remove(tag));
    this.actionHistoryService.record(userId, {
      entityType: "tag",
      entityId: id,
      action: "delete",
      beforeData,
      description: `Deleted tag "${beforeData.name}"`,
      descriptionKey: "deletedTag",
      descriptionParams: { name: beforeData.name },
    });
  }

  async getTransactionCount(userId: string, id: string): Promise<number> {
    await this.findOne(userId, id);
    return tenantTx(this.dataSource, (m) =>
      m.getRepository(TransactionTag).count({
        where: { tagId: id },
      }),
    );
  }

  async getAllTransactionCounts(
    userId: string,
  ): Promise<Record<string, number>> {
    const rows: Array<{ tag_id: string; count: string }> = await tenantTx(
      this.dataSource,
      (m) =>
        m
          .getRepository(TransactionTag)
          .createQueryBuilder("tt")
          .select("tt.tag_id", "tag_id")
          .addSelect("COUNT(*)", "count")
          .innerJoin(Tag, "t", "t.id = tt.tag_id AND t.user_id = :userId", {
            userId,
          })
          .groupBy("tt.tag_id")
          .getRawMany(),
    );

    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.tag_id] = Number(row.count);
    }
    return counts;
  }

  /**
   * Run `fn` against the caller's QueryRunner transaction when one is passed
   * (the transactions module's flows still manage their own QueryRunner until
   * task R2), otherwise inside a `tenantTx` of our own.
   */
  private withTagManager<T>(
    queryRunner: QueryRunner | undefined,
    fn: (m: EntityManager) => Promise<T>,
  ): Promise<T> {
    return queryRunner
      ? fn(queryRunner.manager)
      : tenantTx(this.dataSource, fn);
  }

  async setTransactionTags(
    transactionId: string,
    tagIds: string[],
    userId: string,
    queryRunner?: QueryRunner,
  ): Promise<void> {
    return this.withTagManager(queryRunner, async (manager) => {
      // Validate all tags belong to this user
      if (tagIds.length > 0) {
        const tags = await manager.find(Tag, {
          where: { id: In(tagIds), userId },
        });
        if (tags.length !== tagIds.length) {
          throw new NotFoundException(
            tr("errors.tags.oneOrMoreNotFound", "One or more tags not found"),
          );
        }
      }

      // Delete existing and insert new
      await manager.delete(TransactionTag, { transactionId });

      if (tagIds.length > 0) {
        const newTags = tagIds.map((tagId) =>
          manager.create(TransactionTag, { transactionId, tagId }),
        );
        await manager.save(TransactionTag, newTags);
      }
    });
  }

  /**
   * Set the same tag set on many transactions at once. Validates the tag set a
   * single time, then replaces tags with one bulk DELETE and one multi-row
   * INSERT instead of running validate + delete + insert per transaction (which
   * is ~3N queries for N transactions in a bulk update).
   */
  async setTransactionTagsBulk(
    transactionIds: string[],
    tagIds: string[],
    userId: string,
    queryRunner?: QueryRunner,
  ): Promise<void> {
    if (transactionIds.length === 0) {
      return;
    }
    return this.withTagManager(queryRunner, async (manager) => {
      // Validate the tag set once for all transactions
      if (tagIds.length > 0) {
        const tags = await manager.find(Tag, {
          where: { id: In(tagIds), userId },
        });
        if (tags.length !== tagIds.length) {
          throw new NotFoundException(
            tr("errors.tags.oneOrMoreNotFound", "One or more tags not found"),
          );
        }
      }

      // Replace existing tags for every target transaction in one statement
      await manager.delete(TransactionTag, {
        transactionId: In(transactionIds),
      });

      if (tagIds.length > 0) {
        const newTags = transactionIds.flatMap((transactionId) =>
          tagIds.map((tagId) =>
            manager.create(TransactionTag, { transactionId, tagId }),
          ),
        );
        await manager.save(TransactionTag, newTags);
      }
    });
  }

  /**
   * Set the same tag set on many transaction splits at once. Bulk counterpart
   * of setSplitTags, mirroring setTransactionTagsBulk: one validation pass,
   * one bulk DELETE, one multi-row INSERT.
   */
  async setSplitTagsBulk(
    transactionSplitIds: string[],
    tagIds: string[],
    userId: string,
    queryRunner?: QueryRunner,
  ): Promise<void> {
    if (transactionSplitIds.length === 0) {
      return;
    }
    return this.withTagManager(queryRunner, async (manager) => {
      if (tagIds.length > 0) {
        const tags = await manager.find(Tag, {
          where: { id: In(tagIds), userId },
        });
        if (tags.length !== tagIds.length) {
          throw new NotFoundException(
            tr("errors.tags.oneOrMoreNotFound", "One or more tags not found"),
          );
        }
      }

      await manager.delete(TransactionSplitTag, {
        transactionSplitId: In(transactionSplitIds),
      });

      if (tagIds.length > 0) {
        const newTags = transactionSplitIds.flatMap((transactionSplitId) =>
          tagIds.map((tagId) =>
            manager.create(TransactionSplitTag, { transactionSplitId, tagId }),
          ),
        );
        await manager.save(TransactionSplitTag, newTags);
      }
    });
  }

  async setSplitTags(
    transactionSplitId: string,
    tagIds: string[],
    userId: string,
    queryRunner?: QueryRunner,
  ): Promise<void> {
    return this.withTagManager(queryRunner, async (manager) => {
      if (tagIds.length > 0) {
        const tags = await manager.find(Tag, {
          where: { id: In(tagIds), userId },
        });
        if (tags.length !== tagIds.length) {
          throw new NotFoundException(
            tr("errors.tags.oneOrMoreNotFound", "One or more tags not found"),
          );
        }
      }

      await manager.delete(TransactionSplitTag, { transactionSplitId });

      if (tagIds.length > 0) {
        const newTags = tagIds.map((tagId) =>
          manager.create(TransactionSplitTag, { transactionSplitId, tagId }),
        );
        await manager.save(TransactionSplitTag, newTags);
      }
    });
  }
}
