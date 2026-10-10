import { BadRequestException } from "@nestjs/common";
import {
  ParseAssumePipe,
  ParseBenchmarkIdPipe,
  ParseScenarioValuesPipe,
} from "./bond-query.pipes";

describe("ParseAssumePipe", () => {
  const pipe = new ParseAssumePipe();

  it("is no assumption when the key is absent or empty", () => {
    expect(pipe.transform(undefined)).toBeUndefined();
    expect(pipe.transform("")).toBeUndefined();
  });

  it.each(["PL_CPI_GUS_YOY:0.05", "X:-0.5", "X:1.0", "X:1", "A1_B:0"])(
    "accepts %s",
    (text) => {
      const [id, value] = text.split(":");
      expect(pipe.transform(text)).toEqual(new Map([[id, value]]));
    },
  );

  it.each([
    "PL_CPI_GUS_YOY",
    ":0.05",
    "pl_cpi:0.05",
    "X:",
    "X:abc",
    "X:0.05:1",
    "X:-0.51",
    "X:1.01",
    "X:1e-1",
    " X:0.05",
    `${"A".repeat(41)}:0.05`,
    "X:0.05'; DROP TABLE a",
  ])("refuses %s with a 400", (text) => {
    expect(() => pipe.transform(text)).toThrow(BadRequestException);
  });

  it("refuses a repeated key (an array), not coerces it", () => {
    expect(() => pipe.transform(["X:0.05", "X:0.06"])).toThrow(
      BadRequestException,
    );
  });
});

describe("ParseBenchmarkIdPipe", () => {
  const pipe = new ParseBenchmarkIdPipe();

  it("accepts 1 to 40 capital letters, digits and underscores", () => {
    expect(pipe.transform("PL_CPI_GUS_YOY")).toBe("PL_CPI_GUS_YOY");
    expect(pipe.transform("A".repeat(40))).toBe("A".repeat(40));
  });

  it.each([undefined, "", "a", "A-B", "A".repeat(41), ["A", "B"]])(
    "refuses %p",
    (value) => {
      expect(() => pipe.transform(value)).toThrow(BadRequestException);
    },
  );
});

describe("ParseScenarioValuesPipe", () => {
  const pipe = new ParseScenarioValuesPipe();

  it("splits 1 to 6 bounded decimals, keeping the text", () => {
    expect(pipe.transform("0.025")).toEqual(["0.025"]);
    expect(pipe.transform("0, 0.025,0.05,0.08,-0.5,1.0")).toEqual([
      "0",
      "0.025",
      "0.05",
      "0.08",
      "-0.5",
      "1.0",
    ]);
  });

  it.each([
    undefined,
    "",
    "0,",
    "0,,1",
    "a",
    "0.05,1.5",
    "-0.6",
    "0,0,0,0,0,0,0",
    ["0", "1"],
  ])("refuses %p", (value) => {
    expect(() => pipe.transform(value)).toThrow(BadRequestException);
  });
});
