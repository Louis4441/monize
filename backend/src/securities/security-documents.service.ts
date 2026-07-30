import { Injectable, NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { tr } from "../i18n/translate";
import {
  SecurityDocument,
  SecurityDocumentType,
} from "./entities/security-document.entity";
import { CreateSecurityDocumentDto } from "./dto/create-security-document.dto";
import { UpdateSecurityDocumentDto } from "./dto/update-security-document.dto";
import { SecuritiesService } from "./securities.service";

/**
 * Documents recorded against a security: a factsheet, a KIID, an annual report.
 *
 * Every method takes the security through `SecuritiesService.findOne` first, so
 * ownership is checked once, in the place that already knows how, and a document
 * can never be hung off someone else's security by id.
 */
@Injectable()
export class SecurityDocumentsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly securitiesService: SecuritiesService,
  ) {}

  async findAll(
    userId: string,
    securityId: string,
  ): Promise<SecurityDocument[]> {
    await this.securitiesService.findOne(userId, securityId);
    return withScopedDb(this.dataSource, (m) =>
      m.getRepository(SecurityDocument).find({
        where: { userId, securityId },
        // Newest document first, and the undated ones after those that have a
        // date rather than sorted among them as if they were the oldest.
        order: {
          documentDate: { direction: "DESC", nulls: "LAST" },
          name: "ASC",
        },
      }),
    );
  }

  async create(
    userId: string,
    securityId: string,
    dto: CreateSecurityDocumentDto,
  ): Promise<SecurityDocument> {
    await this.securitiesService.findOne(userId, securityId);
    return withScopedDb(this.dataSource, (m) => {
      const repo = m.getRepository(SecurityDocument);
      return repo.save(
        repo.create({
          userId,
          securityId,
          documentType: dto.documentType ?? SecurityDocumentType.OTHER,
          name: dto.name,
          documentDate: dto.documentDate ?? null,
          url: dto.url,
          notes: dto.notes ?? null,
        }),
      );
    });
  }

  async update(
    userId: string,
    securityId: string,
    documentId: string,
    dto: UpdateSecurityDocumentDto,
  ): Promise<SecurityDocument> {
    await this.securitiesService.findOne(userId, securityId);
    return withScopedDb(this.dataSource, async (m) => {
      const repo = m.getRepository(SecurityDocument);
      const document = await repo.findOne({
        where: { id: documentId, userId, securityId },
      });
      if (!document) throw this.notFound();

      // Only what was sent: `documentDate` and `notes` are clearable, so an
      // explicit null has to survive, which `?? existing` would swallow.
      if (dto.documentType !== undefined)
        document.documentType = dto.documentType;
      if (dto.name !== undefined) document.name = dto.name;
      if (dto.documentDate !== undefined)
        document.documentDate = dto.documentDate ?? null;
      if (dto.url !== undefined) document.url = dto.url;
      if (dto.notes !== undefined) document.notes = dto.notes ?? null;

      return repo.save(document);
    });
  }

  async remove(
    userId: string,
    securityId: string,
    documentId: string,
  ): Promise<void> {
    await this.securitiesService.findOne(userId, securityId);
    await withScopedDb(this.dataSource, async (m) => {
      const result = await m
        .getRepository(SecurityDocument)
        .delete({ id: documentId, userId, securityId });
      // Scoped by userId and securityId in the delete itself, so a zero count
      // means "not yours or not there" without a separate read to find out.
      if (!result.affected) throw this.notFound();
    });
  }

  private notFound(): NotFoundException {
    return new NotFoundException(
      tr("errors.securities.documentNotFound", "Document not found"),
    );
  }
}
