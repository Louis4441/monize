import { PartialType } from "@nestjs/swagger";
import { CreateSecurityDocumentDto } from "./create-security-document.dto";

/**
 * Every field optional, validated exactly as on create -- including the URL
 * scheme check, so an edit cannot smuggle in an address a create would refuse.
 */
export class UpdateSecurityDocumentDto extends PartialType(
  CreateSecurityDocumentDto,
) {}
