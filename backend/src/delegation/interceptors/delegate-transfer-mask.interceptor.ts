import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Request } from "express";
import { Observable, from, of, switchMap } from "rxjs";
import { map } from "rxjs/operators";
import { CrossOwnerAccessService } from "../cross-owner-access.service";
import {
  maskTransactionsAgainst,
  payloadHasCrossOwnerTransfer,
} from "../transfer-mask.util";

/**
 * Masks transfer counterparts the reader cannot READ: the linked leg's
 * account is replaced with the "Hidden account" stub and the auto payee tail
 * is rewritten (see transfer-mask.util.ts).
 *
 * Originally delegate-only (2B). With cross-owner transfers a NON-acting user
 * can also hold a leg whose counterpart they lost access to (unshare), so the
 * interceptor now runs for every authenticated user -- with a load-bearing
 * fast path: the payload is scanned first, and the grants query only runs
 * when the request is acting-as-owner OR some row is a transfer with a
 * cross-owner linked leg. Ordinary same-owner traffic never pays a DB hit.
 *
 * The readable set is keyed by the REAL user (own accounts + can_read
 * grants across all their active delegations), so a delegate legitimately
 * keeps seeing their own counterpart account while acting.
 */
@Injectable()
export class DelegateTransferMaskInterceptor implements NestInterceptor {
  constructor(private readonly crossOwnerAccess: CrossOwnerAccessService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();
    const req = context.switchToHttp().getRequest<
      Request & {
        user?: {
          id?: string;
          realUserId?: string;
          isActing?: boolean;
          delegationId?: string;
        };
      }
    >();
    const user = req.user;
    if (!user?.id) {
      return next.handle();
    }
    const isActing = !!user.isActing && !!user.delegationId;
    const realUserId = user.realUserId ?? user.id;

    return next.handle().pipe(
      switchMap((body) => {
        if (!isActing && !payloadHasCrossOwnerTransfer(body)) {
          return of(body);
        }
        return from(
          this.crossOwnerAccess.readableAccountIdSetFor(realUserId),
        ).pipe(
          map((readable) => {
            maskTransactionsAgainst(readable, body);
            return body;
          }),
        );
      }),
    );
  }
}
