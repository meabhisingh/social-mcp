export type Platform = "youtube" | "instagram" | "x";

export type PostStatus = "scheduled" | "publishing" | "published" | "failed" | "cancelled";

export type PrivacyStatus = "public" | "private" | "unlisted";

export type InstagramKind = "image" | "reel" | "story";

export type PostRecord = {
  id: string;
  platform: Platform;
  content: string;
  mediaPath: string;
  runAt: string | null;
  status: PostStatus;
  title?: string;
  privacyStatus?: PrivacyStatus;
  categoryId?: string;
  tags?: string[];
  madeForKids?: boolean;
  mediaType?: InstagramKind;
  shareToFeed?: boolean;
  altText?: string;
  collaborators?: string[];
  invitesSent?: string[];
  platformId?: string;
  containerId?: string;
  mediaId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
};

export type PublishResult = {
  id: string;
  platform: Platform;
  platformId: string;
  status: "published";
  publishedAt: string;
  containerId?: string;
  mediaId?: string;
  invitesSent?: string[];
};

export type FetchLike = typeof fetch;

export type NetDeps = {
  fetchImpl?: FetchLike;
  youtubeApiBase?: string;
  youtubeTokenUrl?: string;
  instagramGraphBase?: string;
  instagramUploadBase?: string;
  xApiBase?: string;
};

export type LocalMedia = {
  kind: "file";
  path: string;
  size: number;
  mime: string;
  filename: string;
};

export type RemoteMedia = {
  kind: "url";
  url: string;
  mime: string | undefined;
};

export type MediaRef = LocalMedia | RemoteMedia;
