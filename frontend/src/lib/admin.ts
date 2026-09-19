import apiClient from './api';
import { AdminUser } from '@/types/auth';

export interface ResetPasswordResponse {
  temporaryPassword: string;
}

export interface CreateUserPayload {
  email: string;
  firstName?: string;
  lastName?: string;
  password?: string;
  sendInvite?: boolean;
  role?: 'admin' | 'user';
}

export interface CreateUserResponse extends AdminUser {
  temporaryPassword?: string;
  invited: boolean;
  upgraded: boolean;
}

/**
 * How much of the backup store one user's automatic backups occupy.
 *
 * `artifacts` and `bytes` are `null` together, and only when the server could
 * not enumerate the store at all -- a misconfigured backup root, an object
 * store that refused the listing. That is not the same as a user with nothing
 * stored, who enumerates fine and answers `0`, so the table renders the two
 * differently rather than printing "0 bytes" over an answer nobody obtained.
 *
 * `enabled` is the schedule as it stands now: a user switched off last week
 * still occupies whatever their retention window has not aged out.
 */
export interface AdminBackupStorage {
  enabled: boolean;
  artifacts: number | null;
  bytes: number | null;
}

/**
 * How much one user's attachments occupy. Never null: the figures are a COUNT
 * and a SUM over the metadata rows that record each file's size, so they are
 * complete whichever provider holds the bytes, and an account with no
 * attachments genuinely stores zero.
 */
export interface AdminAttachmentStorage {
  files: number;
  bytes: number;
}

export interface AdminUserStorage {
  userId: string;
  backups: AdminBackupStorage;
  attachments: AdminAttachmentStorage;
}

export const adminApi = {
  getUsers: async (): Promise<AdminUser[]> => {
    const response = await apiClient.get<AdminUser[]>('/admin/users');
    return response.data;
  },

  /**
   * Per-user storage usage, deliberately separate from `getUsers`: it
   * enumerates the backup store once per user, which on an S3 target is a round
   * trip each, so the user list renders first and the two storage columns fill
   * in when this answers.
   */
  getUserStorage: async (): Promise<AdminUserStorage[]> => {
    const response = await apiClient.get<AdminUserStorage[]>(
      '/admin/users/storage',
    );
    return response.data;
  },

  createUser: async (
    payload: CreateUserPayload,
  ): Promise<CreateUserResponse> => {
    const response = await apiClient.post<CreateUserResponse>(
      '/admin/users',
      payload,
    );
    return response.data;
  },

  updateUserRole: async (
    userId: string,
    role: 'admin' | 'user',
  ): Promise<AdminUser> => {
    const response = await apiClient.patch<AdminUser>(
      `/admin/users/${userId}/role`,
      { role },
    );
    return response.data;
  },

  updateUserStatus: async (
    userId: string,
    isActive: boolean,
  ): Promise<AdminUser> => {
    const response = await apiClient.patch<AdminUser>(
      `/admin/users/${userId}/status`,
      { isActive },
    );
    return response.data;
  },

  deleteUser: async (userId: string): Promise<{ downgraded: boolean }> => {
    const response = await apiClient.delete<{ downgraded: boolean }>(
      `/admin/users/${userId}`,
    );
    return response.data;
  },

  resetUserPassword: async (
    userId: string,
  ): Promise<ResetPasswordResponse> => {
    const response = await apiClient.post<ResetPasswordResponse>(
      `/admin/users/${userId}/reset-password`,
    );
    return response.data;
  },
};
