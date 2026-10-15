import type { FieldsData } from "@kenjiuno/msgreader";
import { buildRfc822FromMsg, readMsgAsRfc822 } from "./msg-message";
import { extractMailText } from "../imap/mail-text.util";

/** The fields msgreader returns for a message; only what the builder reads. */
const fields = (over: Partial<FieldsData> = {}): FieldsData =>
  ({ dataType: "msg", ...over }) as FieldsData;

const build = (over: Partial<FieldsData>) =>
  buildRfc822FromMsg(fields(over)).toString("utf8");

describe("buildRfc822FromMsg", () => {
  it("ends the header block with an empty line before the first boundary", () => {
    const source = build({ body: "text", bodyHtml: "<p>html</p>" });
    expect(source).toMatch(
      /boundary="(monize-[0-9a-f]+)"\r\n\r\n--monize-[0-9a-f]+\r\n/,
    );
  });

  it("builds the headers from the properties when there are no transport headers", async () => {
    const source = buildRfc822FromMsg(
      fields({
        senderName: "Example Shop",
        senderEmail: "Orders@Shop.Example.com",
        subject: "Your order 123",
        clientSubmitTime: "Mon, 22 May 2023 06:49:17 GMT",
        messageId: "m1@shop.example.com",
        body: "Order total: 15.00 PLN",
      }),
    );
    const mail = await extractMailText(source);
    expect(mail).toMatchObject({
      fromAddress: "orders@shop.example.com",
      fromDomain: "shop.example.com",
      subject: "Your order 123",
      messageId: "<m1@shop.example.com>",
      html: null,
    });
    expect(mail.date?.toISOString()).toBe("2023-05-22T06:49:17.000Z");
    expect(mail.text).toContain("Order total: 15.00 PLN");
  });

  it("prefers the original transport headers, field by field", async () => {
    const mail = await extractMailText(
      buildRfc822FromMsg(
        fields({
          headers: [
            "Received: from mx.example.net",
            "From: Shop <orders@shop.example.com>",
            "Subject: Order with a very long",
            " folded subject",
            "Date: Tue, 23 May 2023 07:00:00 +0000",
            "Message-ID: <real@shop.example.com>",
            "Message-ID: <second@shop.example.com>",
            "",
            "Subject: not a header",
          ].join("\r\n"),
          senderEmail: "other@example.org",
          subject: "property subject",
          messageId: "prop-id",
          body: "hello",
        }),
      ),
    );
    expect(mail.fromAddress).toBe("orders@shop.example.com");
    expect(mail.subject).toBe("Order with a very long folded subject");
    expect(mail.messageId).toBe("<real@shop.example.com>");
    expect(mail.date?.toISOString()).toBe("2023-05-23T07:00:00.000Z");
  });

  it("falls back to a property for a header the transport block lacks", async () => {
    const mail = await extractMailText(
      buildRfc822FromMsg(
        fields({
          headers: "From: orders@shop.example.com\r\n",
          subject: "From the property",
          body: "x",
        }),
      ),
    );
    expect(mail.fromAddress).toBe("orders@shop.example.com");
    expect(mail.subject).toBe("From the property");
  });

  it("encodes non-ASCII text and keeps UTF-8 bodies intact", async () => {
    const mail = await extractMailText(
      buildRfc822FromMsg(
        fields({
          senderName: "Sklep Zażółć",
          senderEmail: "sklep@shop.example.com",
          subject: "Zamówienie nr 1: żółw",
          body: "Razem do zapłaty: 15,00 zł",
        }),
      ),
    );
    expect(mail.subject).toBe("Zamówienie nr 1: żółw");
    expect(mail.text).toContain("Razem do zapłaty: 15,00 zł");
    expect(mail.fromAddress).toBe("sklep@shop.example.com");
  });

  it("cannot be made to inject a header through a value", () => {
    const text = build({
      senderEmail: "a@shop.example.com>\r\nBcc: victim@example.net",
      senderName: 'Eve"\r\nX-Evil: 1',
      subject: "Hi\r\nBcc: victim@example.net",
      messageId: "id>\r\nX-Evil: 1",
      headers: "Subject: ok\r\n",
      body: "x",
    });
    const head = text.slice(0, text.indexOf("\r\n\r\n"));
    expect(head).not.toMatch(/^(Bcc|X-Evil):/im);
    for (const line of head.split("\r\n")) {
      expect(line).toMatch(/^[A-Za-z-]+: /);
    }
  });

  it("sends a plain and an HTML body as multipart/alternative", async () => {
    const mail = await extractMailText(
      buildRfc822FromMsg(
        fields({
          senderEmail: "a@shop.example.com",
          body: "plain text",
          bodyHtml: "<p>html <b>part</b></p>",
        }),
      ),
    );
    expect(mail.text).not.toBe("");
    expect(mail.html).toContain("<b>part</b>");
  });

  it("takes an HTML body given as bytes and builds a message from HTML alone", async () => {
    const mail = await extractMailText(
      buildRfc822FromMsg(
        fields({
          senderEmail: "a@shop.example.com",
          html: new TextEncoder().encode("<p>only html</p>"),
        }),
      ),
    );
    expect(mail.html).toContain("only html");
    expect(mail.text).toContain("only html");
  });

  it("builds a message with no body at all", async () => {
    const mail = await extractMailText(buildRfc822FromMsg(fields({})));
    expect(mail.text.trim()).toBe("");
  });

  it("is the same bytes for the same message", () => {
    const over = {
      senderEmail: "a@b.example.com",
      body: "t",
      bodyHtml: "<p>h",
    };
    expect(build(over)).toBe(build(over));
  });
});

describe("readMsgAsRfc822", () => {
  it("is null for bytes that are not an OLE file", () => {
    expect(
      readMsgAsRfc822(Buffer.from("From: a@b.example.com\n\nhi\n")),
    ).toBeNull();
    expect(readMsgAsRfc822(Buffer.alloc(0))).toBeNull();
  });

  it("is null for an OLE signature followed by garbage", () => {
    const bytes = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(600, 0x7f),
    ]);
    expect(readMsgAsRfc822(bytes)).toBeNull();
  });
});
