'use client';

import { useMemo, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { AdminUser } from '@/types/auth';
import { AdminUserStorage } from '@/lib/admin';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { usePreferencesStore } from '@/store/preferencesStore';
import { formatTime } from '@/lib/utils';
import { EmptyState } from '@/components/ui/EmptyState';

/**
 * What the two storage columns know, which is not the same question as what the
 * user list knows: the figures come from their own request, so they are still
 * loading when the rows are already on screen, and they can fail on their own.
 *
 * Three states rather than an optional map, because "not fetched yet", "the
 * request failed" and "fetched, and this user has no row in it" need three
 * different things said to the reader -- and an optional map collapses all
 * three into an empty cell that reads as zero.
 */
export type AdminStorageState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; byUser: Map<string, AdminUserStorage> };

interface UserManagementTableProps {
  users: AdminUser[];
  storage: AdminStorageState;
  currentUserId: string;
  onChangeRole: (user: AdminUser, role: 'admin' | 'user') => void;
  onToggleStatus: (user: AdminUser) => void;
  onResetPassword: (user: AdminUser) => void;
  onDeleteUser: (user: AdminUser) => void;
}

export function UserManagementTable({
  users,
  storage,
  currentUserId,
  onChangeRole,
  onToggleStatus,
  onResetPassword,
  onDeleteUser,
}: UserManagementTableProps) {
  const t = useTranslations('admin');
  const tc = useTranslations('common');
  const { formatDate } = useDateFormat();
  const timeFormat = usePreferencesStore((s) => s.preferences?.timeFormat) || '24h';

  const formatLastLogin = (iso: string): string => {
    const d = new Date(iso);
    const time24 = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return `${formatDate(d)} ${formatTime(time24, timeFormat)}`;
  };

  const sortedUsers = useMemo(() => {
    return [...users].sort((a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
  }, [users]);

  const getUserDisplayName = (user: AdminUser): string => {
    if (user.firstName || user.lastName) {
      return [user.firstName, user.lastName].filter(Boolean).join(' ');
    }
    return user.email || t('userTable.unknown');
  };

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
        <thead className="bg-gray-50 dark:bg-gray-800">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              {t('userTable.colUser')}
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              {t('userTable.colRole')}
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              {t('userTable.colProvider')}
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              {t('userTable.colStatus')}
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              {t('userTable.colLastLogin')}
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              {t('userTable.colBackups')}
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              {t('userTable.colAttachments')}
            </th>
            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider sticky right-0 bg-gray-50 dark:bg-gray-800">
              {t('userTable.colActions')}
            </th>
          </tr>
        </thead>
        <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
          {sortedUsers.map((user) => {
            const isSelf = user.id === currentUserId;
            return (
              <tr key={user.id} className={`group hover:bg-gray-100 dark:hover:bg-gray-800 ${isSelf ? 'bg-blue-50 dark:bg-blue-950' : 'bg-white dark:bg-gray-900'}`}>
                {/* User info */}
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {getUserDisplayName(user)}
                    {isSelf && (
                      <span className="ml-2 text-xs text-blue-600 dark:text-blue-400">{t('userTable.youSuffix')}</span>
                    )}
                  </div>
                  <div className="text-sm text-gray-500 dark:text-gray-400">
                    {user.email || t('userTable.noEmail')}
                  </div>
                </td>

                {/* Role */}
                <td className="px-6 py-4 whitespace-nowrap">
                  {isSelf ? (
                    <RoleBadge role={user.role} adminLabel={t('userTable.roleAdmin')} userLabel={t('userTable.roleUser')} />
                  ) : (
                    <select
                      value={user.role}
                      onChange={(e) => onChangeRole(user, e.target.value as 'admin' | 'user')}
                      className="text-sm rounded-md border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:ring-blue-500 focus:border-blue-500"
                    >
                      <option value="admin">{t('userTable.roleAdmin')}</option>
                      <option value="user">{t('userTable.roleUser')}</option>
                    </select>
                  )}
                </td>

                {/* Provider */}
                <td className="px-6 py-4 whitespace-nowrap">
                  <Badge variant={user.authProvider === 'oidc' ? 'purple' : 'gray'}>
                    {user.authProvider === 'oidc' ? t('userTable.providerSso') : t('userTable.providerLocal')}
                  </Badge>
                </td>

                {/* Status */}
                <td className="px-6 py-4 whitespace-nowrap">
                  {isSelf ? (
                    <StatusBadge isActive={user.isActive} activeLabel={t('userTable.statusActive')} disabledLabel={t('userTable.statusDisabled')} />
                  ) : (
                    <button
                      onClick={() => onToggleStatus(user)}
                      className="group flex items-center"
                      title={user.isActive ? t('userTable.clickToDisable') : t('userTable.clickToEnable')}
                    >
                      <StatusBadge isActive={user.isActive} activeLabel={t('userTable.statusActive')} disabledLabel={t('userTable.statusDisabled')} clickable />
                    </button>
                  )}
                </td>

                {/* Last Login */}
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                  {user.lastLogin ? formatLastLogin(user.lastLogin) : t('userTable.never')}
                </td>

                {/* Automatic backups held for this user */}
                <td className="px-6 py-4 whitespace-nowrap">
                  <BackupUsageCell state={storage} userId={user.id} />
                </td>

                {/* Attachment bytes this user has uploaded */}
                <td className="px-6 py-4 whitespace-nowrap">
                  <AttachmentUsageCell state={storage} userId={user.id} />
                </td>

                {/* Actions */}
                <td className={`px-6 py-4 whitespace-nowrap text-right text-sm space-x-2 sticky right-0 ${isSelf ? 'bg-blue-50 dark:bg-blue-950' : 'bg-white dark:bg-gray-900'} group-hover:bg-gray-100 dark:group-hover:bg-gray-800`}>
                  {!isSelf && (
                    <>
                      {user.hasPassword && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => onResetPassword(user)}
                        >
                          {t('userTable.resetPassword')}
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onDeleteUser(user)}
                        className="text-red-600 border-red-300 hover:bg-red-50 dark:text-red-400 dark:border-red-700 dark:hover:bg-red-900/50"
                      >
                        {tc('delete')}
                      </Button>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {sortedUsers.length === 0 && (
        <EmptyState title={t('userTable.noUsers')} />
      )}
    </div>
  );
}

/**
 * A figure that is not a figure: still loading, unavailable, or genuinely
 * unknown. Rendered in its own muted style so it cannot be misread as a size,
 * and always carrying the reason -- a cell that only says "Unknown" tells the
 * reader nothing they can act on.
 */
function AbsentFigure({ label, hint }: { label: string; hint?: string }) {
  return (
    <span
      className="text-sm italic text-gray-400 dark:text-gray-500"
      title={hint}
    >
      {label}
    </span>
  );
}

/** A size over the line that says what it covers. */
function StorageFigure({ size, detail, note }: { size: string; detail: string; note?: { label: string; hint: string } }) {
  return (
    <>
      <div className="text-sm text-gray-900 dark:text-gray-100">{size}</div>
      <div className="text-xs text-gray-500 dark:text-gray-400">
        {detail}
        {note && (
          <span className="ml-1 text-amber-600 dark:text-amber-500" title={note.hint}>
            {note.label}
          </span>
        )}
      </div>
    </>
  );
}

/**
 * The shell both storage columns share: the three ways a figure can be absent
 * before either column's own reading begins.
 *
 * Written once because the three are the same question for both columns and
 * because each has to stay distinguishable -- "not fetched yet", "the request
 * failed" and "this user was not in the reading" have three different repairs,
 * and a shared empty cell would read as zero for all of them. `render` is
 * reached only with a reading that actually covers this user.
 */
function StorageCell({
  state,
  userId,
  render,
}: {
  state: AdminStorageState;
  userId: string;
  render: (usage: AdminUserStorage) => ReactNode;
}) {
  const t = useTranslations('admin');

  if (state.status === 'loading') {
    return <AbsentFigure label={t('userTable.storageLoading')} />;
  }
  if (state.status === 'error') {
    return (
      <AbsentFigure
        label={t('userTable.storageUnavailable')}
        hint={t('userTable.storageUnavailableHint')}
      />
    );
  }

  const usage = state.byUser.get(userId);
  if (!usage) {
    return (
      <AbsentFigure
        label={t('userTable.storageNotReported')}
        hint={t('userTable.storageNotReportedHint')}
      />
    );
  }
  return <>{render(usage)}</>;
}

/**
 * How much of the backup store this user's automatic backups occupy.
 *
 * Two absences of its own beyond the shared three: the store could not be
 * enumerated for this user (`bytes` and `artifacts` are null together), and the
 * schedule is off with nothing stored. Neither is zero, and a known zero is a
 * real answer rather than an absence. The schedule is also a separate fact from
 * the bytes -- a user switched off still occupies whatever retention has not
 * aged out -- so "off" is the headline only when there is nothing stored, and a
 * note beside the size otherwise.
 */
function BackupUsageCell({ state, userId }: { state: AdminStorageState; userId: string }) {
  const t = useTranslations('admin');
  const { formatBytes } = useNumberFormat();

  return (
    <StorageCell
      state={state}
      userId={userId}
      render={({ backups: { enabled, artifacts, bytes } }) => {
        if (bytes === null || artifacts === null) {
          return (
            <AbsentFigure
              label={t('userTable.storageUnknown')}
              hint={t('userTable.storageUnknownStore')}
            />
          );
        }
        if (!enabled && artifacts === 0) {
          return (
            <AbsentFigure
              label={t('userTable.backupsOff')}
              hint={t('userTable.backupsOffHint')}
            />
          );
        }
        return (
          <StorageFigure
            size={formatBytes(bytes)}
            detail={t('userTable.backupCount', { count: artifacts })}
            note={
              enabled
                ? undefined
                : {
                    label: t('userTable.backupScheduleOff'),
                    hint: t('userTable.backupScheduleOffHint'),
                  }
            }
          />
        );
      }}
    />
  );
}

/**
 * How much this user's transaction attachments occupy.
 *
 * No unknown of its own, unlike the backups: the figure is a COUNT and a SUM
 * over the metadata rows that record each file's size, so it is known whichever
 * provider holds the bytes -- database, local disk or S3 -- and an account with
 * no attachments genuinely stores zero.
 */
function AttachmentUsageCell({ state, userId }: { state: AdminStorageState; userId: string }) {
  const t = useTranslations('admin');
  const { formatBytes } = useNumberFormat();

  return (
    <StorageCell
      state={state}
      userId={userId}
      render={({ attachments }) => (
        <StorageFigure
          size={formatBytes(attachments.bytes)}
          detail={t('userTable.attachmentCount', { count: attachments.files })}
        />
      )}
    />
  );
}

function RoleBadge({ role, adminLabel, userLabel }: { role: string; adminLabel: string; userLabel: string }) {
  return (
    <Badge variant={role === 'admin' ? 'blue' : 'gray'}>
      {role === 'admin' ? adminLabel : userLabel}
    </Badge>
  );
}

function StatusBadge({ isActive, activeLabel, disabledLabel, clickable }: { isActive: boolean; activeLabel: string; disabledLabel: string; clickable?: boolean }) {
  return (
    <Badge
      variant={isActive ? 'green' : 'red'}
      className={clickable ? 'cursor-pointer hover:opacity-80' : undefined}
    >
      {isActive ? activeLabel : disabledLabel}
    </Badge>
  );
}
