import { ArrayMaxSize, IsArray, IsUUID } from "class-validator";

export class ReorderScenariosDto {
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID("4", { each: true })
  scenarioIds: string[];
}
