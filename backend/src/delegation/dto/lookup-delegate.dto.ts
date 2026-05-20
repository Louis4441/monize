import { IsEmail, MaxLength } from "class-validator";

export class LookupDelegateDto {
  @IsEmail()
  @MaxLength(255)
  email: string;
}
