import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  PayloadTooLargeException,
} from "@nestjs/common";
import { Observable, catchError, throwError } from "rxjs";
import { tr } from "../../i18n/translate";

/** Largest single file of an archive import, in MB (multer's `fileSize`). */
export const EMAIL_IMPORT_FILE_LIMIT_MB = 25;
export const EMAIL_IMPORT_FILE_LIMIT_BYTES =
  EMAIL_IMPORT_FILE_LIMIT_MB * 1024 * 1024;
/** Most files of one archive import request. */
export const EMAIL_IMPORT_MAX_FILES = 20;
/**
 * Largest whole import request, in MB. multer keeps the files in memory, and 20
 * files of 25 MB would hold 500 MB for one request, so the declared body size
 * is refused above this before multer reads a byte. A body of undeclared length
 * (an HTTP/3 edge relays one) is bounded by the frontend's streaming route for
 * this path (`LARGE_UPLOAD_ROUTES`), which cuts it off at the same ceiling.
 */
export const EMAIL_IMPORT_REQUEST_LIMIT_MB = 100;
export const EMAIL_IMPORT_REQUEST_LIMIT_BYTES =
  EMAIL_IMPORT_REQUEST_LIMIT_MB * 1024 * 1024;

/** The request's declared body size, or null when it declares none or an unreadable one. */
function declaredLength(context: ExecutionContext): number | null {
  const request = context
    .switchToHttp()
    .getRequest<{ headers: Record<string, string | string[] | undefined> }>();
  const header = request.headers["content-length"];
  if (typeof header !== "string" || !/^\d+$/.test(header)) return null;
  return Number(header);
}

/**
 * Refuses an import request whose declared body is above
 * `EMAIL_IMPORT_REQUEST_LIMIT_BYTES`, and replaces multer's untranslated "File too large" (a
 * `PayloadTooLargeException`) with a localized 413 that names the limit.
 * Registered before the `FilesInterceptor`, so it runs before multer reads the
 * body and sits outside it, like `MnyUploadErrorInterceptor`.
 */
@Injectable()
export class EmailReceiptUploadErrorInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const length = declaredLength(context);
    if (length !== null && length > EMAIL_IMPORT_REQUEST_LIMIT_BYTES) {
      return throwError(
        () =>
          new PayloadTooLargeException({
            message: tr(
              "errors.emailReceipts.importRequestTooLarge",
              `The files together are larger than the ${EMAIL_IMPORT_REQUEST_LIMIT_MB} MB limit. Import them in smaller groups.`,
              { limit: EMAIL_IMPORT_REQUEST_LIMIT_MB },
            ),
            errorCode: "emailReceiptImportRequestTooLarge",
          }),
      );
    }
    return next.handle().pipe(
      catchError((error: unknown) =>
        throwError(() =>
          error instanceof PayloadTooLargeException
            ? new PayloadTooLargeException({
                message: tr(
                  "errors.emailReceipts.importFileTooLarge",
                  `A file is larger than the ${EMAIL_IMPORT_FILE_LIMIT_MB} MB limit.`,
                  { limit: EMAIL_IMPORT_FILE_LIMIT_MB },
                ),
                errorCode: "emailReceiptImportFileTooLarge",
              })
            : error,
        ),
      ),
    );
  }
}
