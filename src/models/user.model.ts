import type { WithId } from 'mongodb';

export interface User {
  email: string;
  displayName: string;
  passwordHash?: string;
  googleId?: string;
  avatarUrl?: string; // the picture the user chose: uploaded here (/uploads/avatars/...) or, for older accounts, a Google link
  googlePicture?: string; // the picture of the Google account, refreshed at every Google sign-in; never deleted by the user
  createdAt: Date;
  updatedAt: Date;
}

export type UserDoc = WithId<User>;

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl?: string; // the picture to show: the chosen one, else the Google one
  hasCustomAvatar: boolean; // true when the user uploaded one (so there is something to remove)
  createdAt: Date;
}

export interface NewUser {
  email: string;
  displayName: string;
  passwordHash?: string;
  googleId?: string;
  googlePicture?: string;
}

export interface UserUpdate {
  displayName?: string;
  avatarUrl?: string | null;
}

const UPLOADED_AVATAR_PREFIX = '/uploads/avatars/';

/** True for a picture that was uploaded to this server (not a link to somewhere else). */
export const isUploadedAvatar = (avatarUrl: string | undefined): avatarUrl is string =>
  typeof avatarUrl === 'string' && avatarUrl.startsWith(UPLOADED_AVATAR_PREFIX);

export const toPublicUser = ({ _id, email, displayName, avatarUrl, googlePicture, createdAt }: UserDoc): PublicUser => {
  const shown = avatarUrl ?? googlePicture;
  return {
    id: _id.toString(),
    email,
    displayName,
    createdAt,
    hasCustomAvatar: isUploadedAvatar(avatarUrl),
    ...(shown ? { avatarUrl: shown } : {}),
  };
};
