import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CreateSecurityDto } from "./create-security.dto";
import { UpdateSecurityDto } from "./update-security.dto";

const UUID = "11111111-1111-5111-8111-111111111111";

describe.each([CreateSecurityDto, UpdateSecurityDto])(
  "bond instrument link DTO %p",
  (Dto) => {
    const errors = async (value: unknown) =>
      (
        await validate(Object.assign(new Dto(), { bondInstrumentId: value }), {
          skipMissingProperties: false,
        })
      ).filter((e) => e.property === "bondInstrumentId");

    it.each([undefined, null, UUID])(
      "accepts omission, null (unlink) or a UUID: %s",
      async (value) => {
        expect(await errors(value)).toEqual([]);
      },
    );

    it.each(["", "not-a-uuid", 42, "11111111-1111-5111-8111-11111111111g"])(
      "rejects anything else: %p",
      async (value) => {
        expect(await errors(value)).toHaveLength(1);
      },
    );
  },
);

describe.each([CreateSecurityDto, UpdateSecurityDto])(
  "bond instrument link spelling in %p",
  (Dto) => {
    it("is canonicalized to lower case, so the same instrument is never a different link", () => {
      const dto = plainToInstance(Dto, {
        bondInstrumentId: UUID.toUpperCase(),
      });
      expect(dto.bondInstrumentId).toBe(UUID);
    });

    it("leaves null (unlink) and an absent id alone", () => {
      expect(
        plainToInstance(Dto, { bondInstrumentId: null }).bondInstrumentId,
      ).toBeNull();
      expect(plainToInstance(Dto, {}).bondInstrumentId).toBeUndefined();
    });
  },
);
