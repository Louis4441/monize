import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  PayloadTooLargeException,
} from "@nestjs/common";
import { Observable, catchError, throwError } from "rxjs";
import { tr } from "../../i18n/translate";

/**
 * Replaces multer's untranslated size error with a localized one that names the
 * limit.
 *
 * Nest maps multer's `LIMIT_FILE_SIZE` to a `PayloadTooLargeException` carrying
 * the literal English "File too large", which is the one failure a user hitting
 * the limit will actually see. Registered **before** the `FileInterceptor` so it
 * sits outside it and can observe the error the inner interceptor throws.
 */
@Injectable()
export class MnyUploadErrorInterceptor implements NestInterceptor {
  constructor(private readonly limitMb: number) {}

  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) =>
        throwError(() =>
          error instanceof PayloadTooLargeException
            ? new PayloadTooLargeException({
                message: tr(
                  "errors.import.mnyFileTooLarge",
                  // Interpolated in the fallback too: outside a request context
                  // `tr` returns it verbatim, and a raw `{{ limit }}` is not
                  // something to show a user.
                  `That Money file is larger than the ${this.limitMb} MB import limit.`,
                  { limit: this.limitMb },
                ),
                errorCode: "mnyFileTooLarge",
              })
            : error,
        ),
      ),
    );
  }
}
