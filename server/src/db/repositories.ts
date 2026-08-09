import { databaseManager } from './database.js';
import { SHARE_SESSION_SECRET_SETTING_KEY } from '../constants/app-setting-keys.js';
import { normalizePath, safeJoin } from '../utils/path-utils.js';
import { resolveUniqueSlug, slugifyFolderName } from '../utils/slug.js';
import type {
  AppSettingRecord,
  CollectionMembershipRecord,
  CollectionRecord,
  CollectionSummaryRecord,
  FeedImage,
  FolderAvatarSource,
  FolderImageOrder,
  FolderRole,
  FolderScanStateRecord,
  FolderShareLinkRecord,
  FolderSharePasswordRecord,
  ImageDetail,
  ImageRecord,
  LikeRecord,
  MediaType,
  PlaceKind,
  PlaceRecord,
  PlaybackStrategy,
  ReelCandidate,
  FolderRecord,
  FolderSummaryRecord,
  ScanRunRecord,
  TrashImage,
  TakenAtSource
} from '../types/models.js';

import type { DatabaseSync } from 'node:sqlite';

const database = new Proxy({} as DatabaseSync, {
  get(_target, prop) {
    const conn = databaseManager.connection as any;
    const value = conn[prop];
    return typeof value === 'function' ? value.bind(conn) : value;
  }
});
const EFFECTIVE_FEED_TIME_SQL = 'COALESCE(images.taken_at, images.sort_timestamp)';
const DEFAULT_COLLECTION_SLUG = 'saved';
const DEFAULT_COLLECTION_NAME = 'Saved';
const COVER_FILENAMES = ['cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp', 'cover.avif', 'cover.gif'] as const;
const COVER_FILENAME_SQL = COVER_FILENAMES.map((name) => `'${name}'`).join(', ');
const NORMAL_FOLDER_ROLE_SQL = "folders.role = 'normal'";
const NORMAL_FOLDER_ID_SUBQUERY_SQL = "SELECT id FROM folders WHERE role = 'normal'";
const VISIBLE_IMAGE_WHERE_SQL =
  `images.is_deleted = 0 AND images.is_trashed = 0 AND LOWER(images.filename) NOT IN (${COVER_FILENAME_SQL}) AND ${NORMAL_FOLDER_ROLE_SQL}`;
const VISIBLE_IMAGE_WHERE_UNSCOPED_SQL =
  `is_deleted = 0 AND is_trashed = 0 AND LOWER(filename) NOT IN (${COVER_FILENAME_SQL}) AND folder_id IN (${NORMAL_FOLDER_ID_SUBQUERY_SQL})`;
const STORY_IMAGE_WHERE_SQL = 'images.is_deleted = 0 AND images.is_trashed = 0';
const STORY_IMAGE_WHERE_UNSCOPED_SQL = 'is_deleted = 0 AND is_trashed = 0';
const HAS_AVATAR_STORY_SQL = `
  EXISTS (
    SELECT 1
    FROM folders AS story_folders
    INNER JOIN images AS story_images ON story_images.folder_id = story_folders.id
    WHERE story_folders.story_owner_folder_id = folders.id
      AND story_folders.role IN ('story_root', 'story_capsule')
      AND story_images.is_deleted = 0
      AND story_images.is_trashed = 0
    LIMIT 1
  )
`;
const ACTIVE_FOLDER_AVATAR_IMAGE_ID_SQL = `
  SELECT avatar_images.id
  FROM images AS avatar_images
  WHERE avatar_images.id = folders.avatar_image_id
    AND avatar_images.folder_id = folders.id
    AND avatar_images.is_deleted = 0
    AND avatar_images.is_trashed = 0
  LIMIT 1
`;
const FALLBACK_FOLDER_AVATAR_IMAGE_ID_SQL = `
  SELECT fallback_images.id
  FROM images AS fallback_images
  WHERE fallback_images.folder_id = folders.id
    AND fallback_images.is_deleted = 0
    AND fallback_images.is_trashed = 0
    AND LOWER(fallback_images.filename) NOT IN (${COVER_FILENAME_SQL})
  ORDER BY fallback_images.sort_timestamp DESC, fallback_images.id DESC
  LIMIT 1
`;
const FOLDER_SUMMARY_AVATAR_IMAGE_ID_SQL = `
  COALESCE(
    (${ACTIVE_FOLDER_AVATAR_IMAGE_ID_SQL}),
    (${FALLBACK_FOLDER_AVATAR_IMAGE_ID_SQL})
  )
`;
const FOLDER_SUMMARY_AVATAR_THUMBNAIL_PATH_SQL = `
  COALESCE(
    (
      SELECT avatar_images.thumbnail_path
      FROM images AS avatar_images
      WHERE avatar_images.id = folders.avatar_image_id
        AND avatar_images.folder_id = folders.id
        AND avatar_images.is_deleted = 0
        AND avatar_images.is_trashed = 0
      LIMIT 1
    ),
    (
      SELECT fallback_images.thumbnail_path
      FROM images AS fallback_images
      WHERE fallback_images.folder_id = folders.id
        AND fallback_images.is_deleted = 0
        AND fallback_images.is_trashed = 0
        AND LOWER(fallback_images.filename) NOT IN (${COVER_FILENAME_SQL})
      ORDER BY fallback_images.sort_timestamp DESC, fallback_images.id DESC
      LIMIT 1
    )
  )
`;

function getQualifiedFolderImageOrderSql(order: FolderImageOrder): string {
  return order === 'oldest'
    ? 'images.sort_timestamp ASC, images.id ASC'
    : 'images.sort_timestamp DESC, images.id DESC';
}

function getUnscopedFolderImageOrderSql(order: FolderImageOrder): string {
  return order === 'oldest'
    ? 'sort_timestamp ASC, id ASC'
    : 'sort_timestamp DESC, id DESC';
}
const IMAGE_FILENAME_SEARCH_SQL = 'LOWER(images.filename)';
const FOLDER_NAME_SEARCH_SQL = 'LOWER(folders.name)';
const FOLDER_SLUG_SEARCH_SQL = 'LOWER(folders.slug)';
const FOLDER_PATH_SEARCH_SQL = 'LOWER(folders.folder_path)';
const EXIF_CAMERA_MAKE_SEARCH_SQL =
  "LOWER(COALESCE(CASE WHEN json_valid(images.exif_json) THEN json_extract(images.exif_json, '$.cameraMake') END, ''))";
const EXIF_CAMERA_MODEL_SEARCH_SQL =
  "LOWER(COALESCE(CASE WHEN json_valid(images.exif_json) THEN json_extract(images.exif_json, '$.cameraModel') END, ''))";
const EXIF_LENS_MODEL_SEARCH_SQL =
  "LOWER(COALESCE(CASE WHEN json_valid(images.exif_json) THEN json_extract(images.exif_json, '$.lensModel') END, ''))";
const MEDIA_SEARCH_FIELD_SQL = [
  IMAGE_FILENAME_SEARCH_SQL,
  FOLDER_NAME_SEARCH_SQL,
  FOLDER_SLUG_SEARCH_SQL,
  FOLDER_PATH_SEARCH_SQL,
  EXIF_CAMERA_MAKE_SEARCH_SQL,
  EXIF_CAMERA_MODEL_SEARCH_SQL,
  EXIF_LENS_MODEL_SEARCH_SQL
] as const;
const IMAGE_SAVED_SELECT_SQL = `
    CASE WHEN EXISTS (
      SELECT 1
      FROM collections
      INNER JOIN collection_items ON collection_items.collection_id = collections.id
      WHERE collections.is_default = 1
        AND collection_items.image_id = images.id
    ) THEN 1 ELSE 0 END AS isSaved
`;
const FEED_IMAGE_SELECT_SQL = `
  SELECT
    images.id,
    images.folder_id AS folderId,
    folders.slug AS folderSlug,
    folders.name AS folderName,
    folders.folder_path AS folderPath,
    images.filename,
    images.caption AS caption,
    images.width,
    images.height,
    images.media_type AS mediaType,
    images.duration_ms AS durationMs,
    images.is_animated AS isAnimated,
    images.thumbnail_path AS thumbnailUrl,
    images.preview_path AS previewUrl,
    images.playback_strategy AS playbackStrategy,
    images.sort_timestamp AS sortTimestamp,
    images.taken_at AS takenAt,
    ${IMAGE_SAVED_SELECT_SQL},
    places.id AS placeId,
    places.slug AS placeSlug,
    places.display_name AS placeName,
    places.kind AS placeKind,
    places.is_approximate AS placeIsApproximate
  FROM images
  INNER JOIN folders ON folders.id = images.folder_id
  LEFT JOIN places ON places.id = images.place_id
`;
const FOLDER_SUMMARY_SELECT_SQL = `
  SELECT
    folders.*,
    COUNT(images.id) AS image_count,
    SUM(CASE WHEN images.media_type = 'video' THEN 1 ELSE 0 END) AS video_count,
    MAX(images.mtime_ms) AS latest_image_mtime_ms,
    CASE WHEN ${HAS_AVATAR_STORY_SQL} THEN 1 ELSE 0 END AS has_avatar_story,
    ${FOLDER_SUMMARY_AVATAR_IMAGE_ID_SQL} AS summary_avatar_image_id,
    ${FOLDER_SUMMARY_AVATAR_THUMBNAIL_PATH_SQL} AS summary_avatar_thumbnail_path
  FROM folders
  INNER JOIN images ON images.folder_id = folders.id AND ${VISIBLE_IMAGE_WHERE_SQL}
`;

interface MediaSearchSql {
  whereSql: string;
  whereParams: string[];
  rankSql: string;
  rankParams: string[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function serializeAnimatedFlag(isAnimated: boolean | null | undefined): number {
  return isAnimated ? 1 : 0;
}

function normalizeSearchQuery(query: string): string {
  return query.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function buildMediaSearchSql(query: string): MediaSearchSql | null {
  const normalizedQuery = normalizeSearchQuery(query);
  if (normalizedQuery.length === 0) {
    return null;
  }

  const normalizedTokens = [...new Set(normalizedQuery.split(' ').filter(Boolean))];
  const tokenClauseSql = `(${MEDIA_SEARCH_FIELD_SQL.map((fieldSql) => `${fieldSql} LIKE ? ESCAPE '\\'`).join(' OR ')})`;
  const whereSql = normalizedTokens.map(() => tokenClauseSql).join(' AND ');
  const whereParams = normalizedTokens.flatMap((token) =>
    MEDIA_SEARCH_FIELD_SQL.map(() => `%${escapeLikePattern(token)}%`)
  );
  const queryContainsPattern = `%${escapeLikePattern(normalizedQuery)}%`;
  const queryPrefixPattern = `${escapeLikePattern(normalizedQuery)}%`;

  const rankSqlParts = [
    `CASE
      WHEN ${IMAGE_FILENAME_SEARCH_SQL} = ? THEN 240
      WHEN ${IMAGE_FILENAME_SEARCH_SQL} LIKE ? ESCAPE '\\' THEN 180
      WHEN ${IMAGE_FILENAME_SEARCH_SQL} LIKE ? ESCAPE '\\' THEN 140
      ELSE 0
    END`,
    `CASE
      WHEN ${FOLDER_NAME_SEARCH_SQL} = ? THEN 120
      WHEN ${FOLDER_NAME_SEARCH_SQL} LIKE ? ESCAPE '\\' THEN 84
      WHEN ${FOLDER_NAME_SEARCH_SQL} LIKE ? ESCAPE '\\' THEN 56
      ELSE 0
    END`,
    `CASE
      WHEN ${FOLDER_SLUG_SEARCH_SQL} = ? THEN 76
      WHEN ${FOLDER_SLUG_SEARCH_SQL} LIKE ? ESCAPE '\\' THEN 52
      WHEN ${FOLDER_SLUG_SEARCH_SQL} LIKE ? ESCAPE '\\' THEN 36
      ELSE 0
    END`,
    `CASE WHEN ${FOLDER_PATH_SEARCH_SQL} LIKE ? ESCAPE '\\' THEN 32 ELSE 0 END`,
    `CASE WHEN ${EXIF_CAMERA_MAKE_SEARCH_SQL} LIKE ? ESCAPE '\\' THEN 20 ELSE 0 END`,
    `CASE WHEN ${EXIF_CAMERA_MODEL_SEARCH_SQL} LIKE ? ESCAPE '\\' THEN 20 ELSE 0 END`,
    `CASE WHEN ${EXIF_LENS_MODEL_SEARCH_SQL} LIKE ? ESCAPE '\\' THEN 18 ELSE 0 END`
  ];
  const rankParams: string[] = [
    normalizedQuery,
    queryPrefixPattern,
    queryContainsPattern,
    normalizedQuery,
    queryPrefixPattern,
    queryContainsPattern,
    normalizedQuery,
    queryPrefixPattern,
    queryContainsPattern,
    queryContainsPattern,
    queryContainsPattern,
    queryContainsPattern,
    queryContainsPattern
  ];

  for (const token of normalizedTokens) {
    const tokenPattern = `%${escapeLikePattern(token)}%`;
    rankSqlParts.push(
      `CASE WHEN ${IMAGE_FILENAME_SEARCH_SQL} LIKE ? ESCAPE '\\' THEN 18 ELSE 0 END`,
      `CASE WHEN ${FOLDER_NAME_SEARCH_SQL} LIKE ? ESCAPE '\\' THEN 12 ELSE 0 END`,
      `CASE WHEN ${FOLDER_SLUG_SEARCH_SQL} LIKE ? ESCAPE '\\' THEN 8 ELSE 0 END`,
      `CASE WHEN ${FOLDER_PATH_SEARCH_SQL} LIKE ? ESCAPE '\\' THEN 8 ELSE 0 END`,
      `CASE WHEN ${EXIF_CAMERA_MAKE_SEARCH_SQL} LIKE ? ESCAPE '\\' THEN 6 ELSE 0 END`,
      `CASE WHEN ${EXIF_CAMERA_MODEL_SEARCH_SQL} LIKE ? ESCAPE '\\' THEN 6 ELSE 0 END`,
      `CASE WHEN ${EXIF_LENS_MODEL_SEARCH_SQL} LIKE ? ESCAPE '\\' THEN 6 ELSE 0 END`
    );
    rankParams.push(
      tokenPattern,
      tokenPattern,
      tokenPattern,
      tokenPattern,
      tokenPattern,
      tokenPattern,
      tokenPattern
    );
  }

  return {
    whereSql,
    whereParams,
    rankSql: rankSqlParts.join(' + '),
    rankParams
  };
}

export interface UpsertFolderInput {
  slug: string;
  name: string;
  folderPath: string;
  role?: FolderRole;
  storyOwnerFolderId?: number | null;
}

export interface SaveFolderResult {
  folder: FolderRecord;
  wrote: boolean;
}

export interface CreateFolderShareLinkInput {
  folderId: number;
  tokenHash: string;
  tokenPrefix: string;
  expiresAt: string | null;
}

export interface UpsertFolderSharePasswordInput {
  folderId: number;
  passwordHash: string;
  passwordSalt: string;
}

export interface UpsertImageInput {
  folderId: number;
  placeId?: number | null;
  assetKey?: string | null;
  filename: string;
  extension: string;
  relativePath: string;
  absolutePath: string;
  fileSize: number;
  width: number;
  height: number;
  displayOrientation?: number | null;
  mediaType: MediaType;
  mimeType: string;
  durationMs: number | null;
  isAnimated?: boolean | null;
  fingerprint: string;
  mtimeMs: number;
  firstSeenAt: string;
  sortTimestamp: number;
  takenAt: number;
  takenAtSource: TakenAtSource;
  exifJson: string | null;
  thumbnailPath: string;
  previewPath: string;
  playbackStrategy?: PlaybackStrategy | null;
}

export interface RefreshIndexedImageInput {
  folderId: number;
  placeId?: number | null;
  assetKey?: string | null;
  filename: string;
  extension: string;
  relativePath: string;
  absolutePath: string;
  fileSize: number;
  width: number;
  height: number;
  displayOrientation?: number | null;
  mediaType: MediaType;
  mimeType: string;
  durationMs: number | null;
  isAnimated?: boolean | null;
  fingerprint: string;
  mtimeMs: number;
  takenAt: number;
  takenAtSource: TakenAtSource;
  exifJson: string | null;
  thumbnailPath: string;
  previewPath: string;
  playbackStrategy?: PlaybackStrategy | null;
}

export interface ReconcileImageMoveInput {
  id: number;
  folderId: number;
  placeId?: number | null;
  filename: string;
  extension: string;
  relativePath: string;
  absolutePath: string;
  fileSize: number;
  width: number;
  height: number;
  displayOrientation?: number | null;
  mediaType: MediaType;
  mimeType: string;
  durationMs: number | null;
  isAnimated?: boolean | null;
  fingerprint: string;
  mtimeMs: number;
  takenAt: number;
  takenAtSource: TakenAtSource;
  exifJson: string | null;
  playbackStrategy?: PlaybackStrategy | null;
}

export interface UpsertFolderScanStateInput {
  folderPath: string;
  signature: string;
  fileCount: number;
  maxMtimeMs: number;
  totalSize: number;
}

export interface UpsertCityPlaceInput {
  geonamesId: number;
  displayName: string;
  slug: string;
  latitude: number;
  longitude: number;
  cityName: string;
  admin1Name?: string | null;
  countryName?: string | null;
  countryCode?: string | null;
  confidence?: number | null;
}

export const folderRepository = {
  getAll(): FolderRecord[] {
    return database.prepare('SELECT * FROM folders ORDER BY folder_path COLLATE NOCASE ASC').all() as unknown as FolderRecord[];
  },

  getNormalBySlug(slug: string): FolderRecord | undefined {
    return database.prepare("SELECT * FROM folders WHERE slug = ? AND role = 'normal'").get(slug) as FolderRecord | undefined;
  },

  getAllSummaries(): FolderSummaryRecord[] {
    return database
      .prepare(
        `
        ${FOLDER_SUMMARY_SELECT_SQL}
        WHERE folders.role = 'normal'
        GROUP BY folders.id
        ORDER BY latest_image_mtime_ms DESC, folders.name COLLATE NOCASE ASC, folders.folder_path COLLATE NOCASE ASC
        `
      )
      .all() as unknown as FolderSummaryRecord[];
  },

  getBySlug(slug: string): FolderRecord | undefined {
    return database.prepare('SELECT * FROM folders WHERE slug = ?').get(slug) as FolderRecord | undefined;
  },

  getById(id: number): FolderRecord | undefined {
    return database.prepare('SELECT * FROM folders WHERE id = ?').get(id) as FolderRecord | undefined;
  },

  getByFolderPath(folderPath: string): FolderRecord | undefined {
    return database
      .prepare('SELECT * FROM folders WHERE folder_path = ?')
      .get(normalizePath(folderPath)) as FolderRecord | undefined;
  },

  getSummaryBySlug(slug: string): FolderSummaryRecord | undefined {
    return database
      .prepare(
        `
        ${FOLDER_SUMMARY_SELECT_SQL}
        WHERE folders.slug = ? AND folders.role = 'normal'
        GROUP BY folders.id
        `
      )
      .get(slug) as FolderSummaryRecord | undefined;
  },

  upsert(input: UpsertFolderInput): FolderRecord {
    const normalizedFolderPath = normalizePath(input.folderPath);
    const role = input.role ?? 'normal';
    const storyOwnerFolderId = input.storyOwnerFolderId ?? null;
    database.prepare(
      `
      INSERT INTO folders (slug, name, folder_path, role, story_owner_folder_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(folder_path) DO UPDATE SET
        slug = excluded.slug,
        name = excluded.name,
        role = excluded.role,
        story_owner_folder_id = excluded.story_owner_folder_id,
        updated_at = excluded.updated_at
      `
    ).run(input.slug, input.name, normalizedFolderPath, role, storyOwnerFolderId, nowIso());

    return this.getByFolderPath(normalizedFolderPath) as FolderRecord;
  },

  save(input: UpsertFolderInput): SaveFolderResult {
    const normalizedFolderPath = normalizePath(input.folderPath);
    const existing = this.getByFolderPath(normalizedFolderPath);
    const role = input.role ?? 'normal';
    const storyOwnerFolderId = input.storyOwnerFolderId ?? null;

    if (
      existing &&
      existing.slug === input.slug &&
      existing.role === role &&
      existing.story_owner_folder_id === storyOwnerFolderId
    ) {
      return {
        folder: existing,
        wrote: false
      };
    }

    if (existing) {
      database
        .prepare('UPDATE folders SET slug = ?, role = ?, story_owner_folder_id = ?, updated_at = ? WHERE id = ?')
        .run(input.slug, role, storyOwnerFolderId, nowIso(), existing.id);

      return {
        folder: this.getById(existing.id) as FolderRecord,
        wrote: true
      };
    }

    return {
      folder: this.upsert({
        ...input,
        folderPath: normalizedFolderPath
      }),
      wrote: true
    };
  },

  count(): number {
    return Number(
      (
        database
          .prepare(
            `
            SELECT COUNT(*) AS count
            FROM folders
            WHERE folders.role = 'normal'
              AND EXISTS (
                SELECT 1
                FROM images
                WHERE images.folder_id = folders.id AND ${VISIBLE_IMAGE_WHERE_UNSCOPED_SQL}
              )
            `
          )
          .get() as { count: number }
      ).count
    );
  },

  setAvatar(folderId: number, imageId: number | null, source: FolderAvatarSource = 'auto'): void {
    database.prepare(
      'UPDATE folders SET avatar_image_id = ?, avatar_source = ?, updated_at = ? WHERE id = ? AND (avatar_image_id IS NOT ? OR avatar_source != ?)'
    ).run(
      imageId,
      source,
      nowIso(),
      folderId,
      imageId,
      source
    );
  },

  updateMetadata(slug: string, name: string, description: string | null): FolderRecord | undefined {
    database.prepare("UPDATE folders SET name = ?, description = ?, updated_at = ? WHERE slug = ? AND role = 'normal'").run(
      name,
      description,
      nowIso(),
      slug
    );
    return this.getNormalBySlug(slug);
  },

  delete(id: number): void {
    database.prepare('DELETE FROM folders WHERE id = ?').run(id);
  },

  resolveAvatarSelection(folderId: number): { imageId: number | null; source: FolderAvatarSource } | null {
    const folder = this.getById(folderId);
    if (!folder) {
      return null;
    }

    const explicitCoverImageId = imageRepository.getExplicitCoverImageId(folderId);
    if (explicitCoverImageId !== null) {
      return {
        imageId: explicitCoverImageId,
        source: 'cover'
      };
    }

    if (folder.avatar_source === 'manual' && folder.avatar_image_id !== null) {
      const manualImage = imageRepository.getById(folder.avatar_image_id);
      if (
        manualImage &&
        manualImage.folder_id === folderId &&
        manualImage.is_deleted === 0 &&
        manualImage.is_trashed === 0
      ) {
        return {
          imageId: manualImage.id,
          source: 'manual'
        };
      }
    }

    return {
      imageId: imageRepository.getLatestFolderImageId(folderId),
      source: 'auto'
    };
  },

  syncAvatarSelection(folderId: number): void {
    const nextSelection = this.resolveAvatarSelection(folderId);
    if (!nextSelection) {
      return;
    }

    this.setAvatar(folderId, nextSelection.imageId, nextSelection.source);
  },

  listOwnedStoryFolders(ownerFolderId: number): FolderRecord[] {
    return database
      .prepare(
        `
        SELECT *
        FROM folders
        WHERE story_owner_folder_id = ?
          AND role IN ('story_root', 'story_capsule')
        ORDER BY
          CASE role
            WHEN 'story_root' THEN 0
            ELSE 1
          END,
          name COLLATE NOCASE ASC,
          folder_path COLLATE NOCASE ASC
        `
      )
      .all(ownerFolderId) as unknown as FolderRecord[];
  },

  getOwnedStoryFolderBySlug(ownerFolderId: number, slug: string): FolderRecord | undefined {
    return database
      .prepare(
        `
        SELECT *
        FROM folders
        WHERE story_owner_folder_id = ?
          AND slug = ?
          AND role IN ('story_root', 'story_capsule')
        `
      )
      .get(ownerFolderId, slug) as FolderRecord | undefined;
  },

  hasLegacyStoriesCandidates(): boolean {
    const row = database
      .prepare(
        `
        SELECT 1 AS found
        FROM folders
        WHERE
          LOWER(folder_path) = 'stories'
          OR LOWER(folder_path) LIKE '%/stories'
          OR LOWER(folder_path) LIKE 'stories/%'
          OR LOWER(folder_path) LIKE '%/stories/%'
        LIMIT 1
        `
      )
      .get() as { found: number } | undefined;

    return row?.found === 1;
  }
};

export const placeRepository = {
  list(): Array<PlaceRecord & { post_count: number }> {
    return database
      .prepare(
        `
        SELECT places.*, COUNT(images.id) AS post_count
        FROM places
        INNER JOIN images ON images.place_id = places.id
        INNER JOIN folders ON folders.id = images.folder_id
        WHERE ${VISIBLE_IMAGE_WHERE_SQL}
        GROUP BY places.id
        ORDER BY post_count DESC, places.display_name COLLATE NOCASE ASC
        `
      )
      .all() as unknown as Array<PlaceRecord & { post_count: number }>;
  },

  getBySlug(slug: string): PlaceRecord | undefined {
    return database.prepare('SELECT * FROM places WHERE slug = ?').get(slug) as PlaceRecord | undefined;
  },

  getByGeonamesId(geonamesId: number): PlaceRecord | undefined {
    return database.prepare('SELECT * FROM places WHERE geonames_id = ? LIMIT 1').get(geonamesId) as PlaceRecord | undefined;
  },

  getAllSlugs(): string[] {
    return (database.prepare('SELECT slug FROM places').all() as Array<{ slug: string }>).map((row) => row.slug);
  },

  upsertCity(input: UpsertCityPlaceInput): PlaceRecord {
    const existing = this.getByGeonamesId(input.geonamesId);
    if (existing) {
      database
        .prepare(
          `
          UPDATE places
          SET
            display_name = ?,
            source_confidence = ?,
            latitude = ?,
            longitude = ?,
            city_name = ?,
            admin1_name = ?,
            country_name = ?,
            country_code = ?,
            updated_at = ?
          WHERE id = ?
          `
        )
        .run(
          input.displayName,
          input.confidence ?? null,
          input.latitude,
          input.longitude,
          input.cityName,
          input.admin1Name ?? null,
          input.countryName ?? input.countryCode ?? null,
          input.countryCode ?? null,
          nowIso(),
          existing.id
        );

      return this.getById(existing.id) as PlaceRecord;
    }

    database
      .prepare(
        `
        INSERT INTO places (
          slug, display_name, kind, source, source_confidence, provider, provider_place_id,
          latitude, longitude, city_name, admin1_name, country_name, country_code,
          geonames_id, is_approximate, updated_at
        )
        VALUES (?, ?, 'city', 'offline_city', ?, 'geonames', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        `
      )
      .run(
        input.slug,
        input.displayName,
        input.confidence ?? null,
        String(input.geonamesId),
        input.latitude,
        input.longitude,
        input.cityName,
        input.admin1Name ?? null,
        input.countryName ?? input.countryCode ?? null,
        input.countryCode ?? null,
        input.geonamesId,
        nowIso()
      );

    return this.getByGeonamesId(input.geonamesId) as PlaceRecord;
  },

  getById(id: number): PlaceRecord | undefined {
    return database.prepare('SELECT * FROM places WHERE id = ?').get(id) as PlaceRecord | undefined;
  },

  countVisibleImages(placeId: number, mediaType?: MediaType): number {
    const mediaTypeClause = mediaType ? ' AND images.media_type = ?' : '';
    return Number(
      (
        database
          .prepare(
            `
            SELECT COUNT(*) AS count
            FROM images
            INNER JOIN folders ON folders.id = images.folder_id
            WHERE images.place_id = ? AND ${VISIBLE_IMAGE_WHERE_SQL}${mediaTypeClause}
            `
          )
          .get(...(mediaType ? [placeId, mediaType] : [placeId])) as { count: number }
      ).count
    );
  }
};

export const imageRepository = {
  getByRelativePath(relativePath: string): ImageRecord | undefined {
    return database.prepare('SELECT * FROM images WHERE relative_path = ?').get(relativePath) as ImageRecord | undefined;
  },

  getById(id: number): ImageRecord | undefined {
    return database.prepare('SELECT * FROM images WHERE id = ?').get(id) as ImageRecord | undefined;
  },

  upsert(input: UpsertImageInput): ImageRecord {
    database.prepare(
      `
      INSERT INTO images (
        folder_id, asset_key, filename, extension, relative_path, absolute_path, file_size, width, height, display_orientation,
        media_type, mime_type, duration_ms, is_animated, checksum_or_fingerprint, mtime_ms, first_seen_at, sort_timestamp, taken_at, taken_at_source, exif_json,
        thumbnail_path, preview_path, playback_strategy, is_deleted, deleted_at, is_trashed, trashed_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 0, NULL, ?)
      ON CONFLICT(relative_path) DO UPDATE SET
        folder_id = excluded.folder_id,
        asset_key = COALESCE(images.asset_key, excluded.asset_key),
        filename = excluded.filename,
        extension = excluded.extension,
        absolute_path = excluded.absolute_path,
        file_size = excluded.file_size,
        width = excluded.width,
        height = excluded.height,
        display_orientation = excluded.display_orientation,
        media_type = excluded.media_type,
        mime_type = excluded.mime_type,
        duration_ms = excluded.duration_ms,
        is_animated = excluded.is_animated,
        checksum_or_fingerprint = excluded.checksum_or_fingerprint,
        mtime_ms = excluded.mtime_ms,
        taken_at = excluded.taken_at,
        taken_at_source = excluded.taken_at_source,
        exif_json = excluded.exif_json,
        thumbnail_path = excluded.thumbnail_path,
        preview_path = excluded.preview_path,
        playback_strategy = excluded.playback_strategy,
        is_deleted = 0,
        deleted_at = NULL,
        updated_at = excluded.updated_at
      `
    ).run(
      input.folderId,
      input.assetKey ?? null,
      input.filename,
      input.extension,
      input.relativePath,
      input.absolutePath,
      input.fileSize,
      input.width,
      input.height,
      input.displayOrientation ?? null,
      input.mediaType,
      input.mimeType,
      input.durationMs,
      serializeAnimatedFlag(input.isAnimated),
      input.fingerprint,
      input.mtimeMs,
      input.firstSeenAt,
      input.sortTimestamp,
      input.takenAt,
      input.takenAtSource,
      input.exifJson,
      input.thumbnailPath,
      input.previewPath,
      input.playbackStrategy ?? 'preview',
      nowIso()
    );

    return this.getByRelativePath(input.relativePath) as ImageRecord;
  },

  refreshIndexed(input: RefreshIndexedImageInput): ImageRecord {
    database.prepare(
      `
      UPDATE images
      SET
        folder_id = ?,
        asset_key = COALESCE(asset_key, ?),
        filename = ?,
        extension = ?,
        absolute_path = ?,
        file_size = ?,
        width = ?,
        height = ?,
        display_orientation = ?,
        media_type = ?,
        mime_type = ?,
        duration_ms = ?,
        is_animated = ?,
        checksum_or_fingerprint = ?,
        mtime_ms = ?,
        taken_at = ?,
        taken_at_source = ?,
        exif_json = ?,
        thumbnail_path = ?,
        preview_path = ?,
        playback_strategy = ?,
        is_deleted = 0,
        deleted_at = NULL,
        updated_at = ?
      WHERE relative_path = ?
      `
    ).run(
      input.folderId,
      input.assetKey ?? null,
      input.filename,
      input.extension,
      input.absolutePath,
      input.fileSize,
      input.width,
      input.height,
      input.displayOrientation ?? null,
      input.mediaType,
      input.mimeType,
      input.durationMs,
      serializeAnimatedFlag(input.isAnimated),
      input.fingerprint,
      input.mtimeMs,
      input.takenAt,
      input.takenAtSource,
      input.exifJson,
      input.thumbnailPath,
      input.previewPath,
      input.playbackStrategy ?? 'preview',
      nowIso(),
      input.relativePath
    );

    return this.getByRelativePath(input.relativePath) as ImageRecord;
  },

  markDeleted(relativePath: string): void {
    const deletedAt = nowIso();
    database
      .prepare('UPDATE images SET is_deleted = 1, deleted_at = COALESCE(deleted_at, ?), updated_at = ? WHERE relative_path = ?')
      .run(deletedAt, deletedAt, relativePath);
  },

  markFolderImagesDeleted(folderId: number, activeRelativePaths: string[]): number {
    const rows = database.prepare('SELECT relative_path FROM images WHERE folder_id = ? AND is_deleted = 0').all(folderId) as Array<{ relative_path: string }>;
    const active = new Set(activeRelativePaths);
    let removedCount = 0;

    for (const row of rows) {
      if (!active.has(row.relative_path)) {
        this.markDeleted(row.relative_path);
        removedCount += 1;
      }
    }

    return removedCount;
  },

  markAllDeletedByFolder(folderId: number): number {
    const deletedAt = nowIso();
    const result = database
      .prepare('UPDATE images SET is_deleted = 1, deleted_at = COALESCE(deleted_at, ?), updated_at = ? WHERE folder_id = ? AND is_deleted = 0')
      .run(deletedAt, deletedAt, folderId);
    return Number(result.changes ?? 0);
  },

  reactivate(relativePath: string): void {
    database.prepare('UPDATE images SET is_deleted = 0, deleted_at = NULL, updated_at = ? WHERE relative_path = ?').run(nowIso(), relativePath);
  },

  updateAssetKey(id: number, assetKey: string): void {
    database.prepare('UPDATE images SET asset_key = ?, updated_at = ? WHERE id = ?').run(assetKey, nowIso(), id);
  },

  updateDerivativePaths(id: number, thumbnailPath: string, previewPath: string): void {
    database
      .prepare('UPDATE images SET thumbnail_path = ?, preview_path = ?, updated_at = ? WHERE id = ?')
      .run(thumbnailPath, previewPath, nowIso(), id);
  },

  updateCaption(id: number, caption: string | null): void {
    database.prepare('UPDATE images SET caption = ?, updated_at = ? WHERE id = ?').run(caption, nowIso(), id);
  },

  assignPlace(id: number, placeId: number | null): void {
    database.prepare('UPDATE images SET place_id = ?, updated_at = ? WHERE id = ?').run(placeId, nowIso(), id);
  },

  reconcileMove(input: ReconcileImageMoveInput): ImageRecord {
    database.prepare(
      `
      UPDATE images
      SET
        folder_id = ?,
        filename = ?,
        extension = ?,
        relative_path = ?,
        absolute_path = ?,
        file_size = ?,
        width = ?,
        height = ?,
        display_orientation = ?,
        media_type = ?,
        mime_type = ?,
        duration_ms = ?,
        is_animated = ?,
        checksum_or_fingerprint = ?,
        mtime_ms = ?,
        taken_at = ?,
        taken_at_source = ?,
        exif_json = ?,
        playback_strategy = ?,
        is_deleted = 0,
        deleted_at = NULL,
        updated_at = ?
      WHERE id = ?
      `
    ).run(
      input.folderId,
      input.filename,
      input.extension,
      input.relativePath,
      input.absolutePath,
      input.fileSize,
      input.width,
      input.height,
      input.displayOrientation ?? null,
      input.mediaType,
      input.mimeType,
      input.durationMs,
      serializeAnimatedFlag(input.isAnimated),
      input.fingerprint,
      input.mtimeMs,
      input.takenAt,
      input.takenAtSource,
      input.exifJson,
      input.playbackStrategy ?? 'preview',
      nowIso(),
      input.id
    );

    return this.getById(input.id) as ImageRecord;
  },

  moveToTrash(id: number, trashedAt = nowIso()): boolean {
    const result = database
      .prepare(
        `
        UPDATE images
        SET is_trashed = 1, trashed_at = ?, updated_at = ?
        WHERE id = ? AND is_deleted = 0 AND is_trashed = 0
        `
      )
      .run(trashedAt, nowIso(), id);
    return Number(result.changes ?? 0) > 0;
  },

  restoreFromTrash(id: number): boolean {
    const result = database
      .prepare(
        `
        UPDATE images
        SET is_trashed = 0, trashed_at = NULL, updated_at = ?
        WHERE id = ? AND is_deleted = 0 AND is_trashed = 1
        `
      )
      .run(nowIso(), id);
    return Number(result.changes ?? 0) > 0;
  },

  deleteById(id: number): boolean {
    const result = database.prepare('DELETE FROM images WHERE id = ?').run(id);
    return Number(result.changes ?? 0) > 0;
  },

  listFeed(page: number, limit: number): FeedImage[] {
    const offset = (page - 1) * limit;
    return database.prepare(
      `
      ${FEED_IMAGE_SELECT_SQL}
      WHERE ${VISIBLE_IMAGE_WHERE_SQL}
      ORDER BY images.sort_timestamp DESC, images.id DESC
      LIMIT ? OFFSET ?
      `
    ).all(limit, offset) as unknown as FeedImage[];
  },

  countFeed(): number {
    return Number(
      (database.prepare(`SELECT COUNT(*) AS count FROM images WHERE ${VISIBLE_IMAGE_WHERE_UNSCOPED_SQL}`).get() as { count: number }).count
    );
  },

  countVisibleSearch(query: string): number {
    const mediaSearch = buildMediaSearchSql(query);
    if (!mediaSearch) {
      return 0;
    }

    return Number(
      (
        database
          .prepare(
            `
            SELECT COUNT(*) AS count
            FROM images
            INNER JOIN folders ON folders.id = images.folder_id
            WHERE ${VISIBLE_IMAGE_WHERE_SQL} AND ${mediaSearch.whereSql}
            `
          )
          .get(...mediaSearch.whereParams) as { count: number }
      ).count
    );
  },

  listRecentCandidates(offset: number, limit: number): FeedImage[] {
    return database.prepare(
      `
      ${FEED_IMAGE_SELECT_SQL}
      WHERE ${VISIBLE_IMAGE_WHERE_SQL}
      ORDER BY ${EFFECTIVE_FEED_TIME_SQL} DESC, images.sort_timestamp DESC, images.id DESC
      LIMIT ? OFFSET ?
      `
    ).all(limit, offset) as unknown as FeedImage[];
  },

  countRediscover(cutoffTimestamp: number): number {
    return Number(
      (
        database
          .prepare(`SELECT COUNT(*) AS count FROM images WHERE ${VISIBLE_IMAGE_WHERE_UNSCOPED_SQL} AND ${EFFECTIVE_FEED_TIME_SQL} <= ?`)
          .get(cutoffTimestamp) as { count: number }
      ).count
    );
  },

  listRediscoverCandidates(offset: number, limit: number, cutoffTimestamp: number): FeedImage[] {
    return database.prepare(
      `
      ${FEED_IMAGE_SELECT_SQL}
      LEFT JOIN likes ON likes.image_id = images.id
      WHERE ${VISIBLE_IMAGE_WHERE_SQL} AND ${EFFECTIVE_FEED_TIME_SQL} <= ?
      ORDER BY
        CASE WHEN likes.image_id IS NULL THEN 0 ELSE 1 END DESC,
        ${EFFECTIVE_FEED_TIME_SQL} DESC,
        images.sort_timestamp DESC,
        images.id DESC
      LIMIT ? OFFSET ?
      `
    ).all(cutoffTimestamp, limit, offset) as unknown as FeedImage[];
  },

  listRandom(page: number, limit: number, seed: number): FeedImage[] {
    const offset = (page - 1) * limit;
    return database.prepare(
      `
      ${FEED_IMAGE_SELECT_SQL}
      WHERE ${VISIBLE_IMAGE_WHERE_SQL}
      ORDER BY ABS(((images.id * 1103515245) + (? * 1013904223)) % 2147483647), images.id DESC
      LIMIT ? OFFSET ?
      `
    ).all(seed, limit, offset) as unknown as FeedImage[];
  },

  listVisibleVideoCandidates(): ReelCandidate[] {
    return database.prepare(
      `
      SELECT
        images.id,
        images.folder_id AS folderId,
        folders.slug AS folderSlug,
        folders.name AS folderName,
        folders.folder_path AS folderPath,
        images.filename,
        images.caption AS caption,
        images.width,
        images.height,
        images.media_type AS mediaType,
        images.duration_ms AS durationMs,
        images.is_animated AS isAnimated,
        images.thumbnail_path AS thumbnailUrl,
        images.preview_path AS previewUrl,
        images.playback_strategy AS playbackStrategy,
        images.sort_timestamp AS sortTimestamp,
        images.taken_at AS takenAt,
        ${IMAGE_SAVED_SELECT_SQL},
        places.id AS placeId,
        places.slug AS placeSlug,
        places.display_name AS placeName,
        places.kind AS placeKind,
        places.is_approximate AS placeIsApproximate,
        likes.created_at AS likedAt
      FROM images
      INNER JOIN folders ON folders.id = images.folder_id
      LEFT JOIN places ON places.id = images.place_id
      LEFT JOIN likes ON likes.image_id = images.id
      WHERE ${VISIBLE_IMAGE_WHERE_SQL} AND images.media_type = 'video'
      ORDER BY images.sort_timestamp DESC, images.id DESC
      `
    ).all() as unknown as ReelCandidate[];
  },

  listVisibleSearch(query: string, page: number, limit: number): FeedImage[] {
    const mediaSearch = buildMediaSearchSql(query);
    if (!mediaSearch) {
      return [];
    }

    const offset = (page - 1) * limit;
    return database.prepare(
      `
      SELECT
        search_results.id,
        search_results.folderId,
        search_results.folderSlug,
        search_results.folderName,
        search_results.folderPath,
        search_results.filename,
        search_results.caption,
        search_results.width,
        search_results.height,
        search_results.mediaType,
        search_results.durationMs,
        search_results.isAnimated,
        search_results.thumbnailUrl,
        search_results.previewUrl,
        search_results.playbackStrategy,
        search_results.sortTimestamp,
        search_results.takenAt,
        search_results.isSaved,
        search_results.placeId,
        search_results.placeSlug,
        search_results.placeName,
        search_results.placeKind,
        search_results.placeIsApproximate
      FROM (
        SELECT
          images.id,
          images.folder_id AS folderId,
          folders.slug AS folderSlug,
          folders.name AS folderName,
          folders.folder_path AS folderPath,
          images.filename,
          images.caption AS caption,
          images.width,
          images.height,
          images.media_type AS mediaType,
          images.duration_ms AS durationMs,
          images.is_animated AS isAnimated,
          images.thumbnail_path AS thumbnailUrl,
          images.preview_path AS previewUrl,
          images.playback_strategy AS playbackStrategy,
          images.sort_timestamp AS sortTimestamp,
          images.taken_at AS takenAt,
          ${IMAGE_SAVED_SELECT_SQL},
          places.id AS placeId,
          places.slug AS placeSlug,
          places.display_name AS placeName,
          places.kind AS placeKind,
          places.is_approximate AS placeIsApproximate,
          (${mediaSearch.rankSql}) AS searchRank
        FROM images
        INNER JOIN folders ON folders.id = images.folder_id
        LEFT JOIN places ON places.id = images.place_id
        WHERE ${VISIBLE_IMAGE_WHERE_SQL} AND ${mediaSearch.whereSql}
      ) AS search_results
      ORDER BY search_results.searchRank DESC, search_results.sortTimestamp DESC, search_results.id DESC
      LIMIT ? OFFSET ?
      `
    ).all(...mediaSearch.rankParams, ...mediaSearch.whereParams, limit, offset) as unknown as FeedImage[];
  },

  countByMonthDayKeys(monthDayKeys: string[], maxYearExclusive: number): number {
    if (monthDayKeys.length === 0) {
      return 0;
    }

    const placeholders = monthDayKeys.map(() => '?').join(', ');
    return Number(
      (
        database
          .prepare(
            `
            SELECT COUNT(*) AS count
            FROM images
            WHERE ${VISIBLE_IMAGE_WHERE_UNSCOPED_SQL}
              AND strftime('%m-%d', ${EFFECTIVE_FEED_TIME_SQL} / 1000, 'unixepoch', 'localtime') IN (${placeholders})
              AND CAST(strftime('%Y', ${EFFECTIVE_FEED_TIME_SQL} / 1000, 'unixepoch', 'localtime') AS INTEGER) < ?
            `
          )
          .get(...monthDayKeys, maxYearExclusive) as { count: number }
      ).count
    );
  },

  listByMonthDayKeys(monthDayKeys: string[], maxYearExclusive: number, page: number, limit: number): FeedImage[] {
    if (monthDayKeys.length === 0) {
      return [];
    }

    const offset = (page - 1) * limit;
    const placeholders = monthDayKeys.map(() => '?').join(', ');

    return database.prepare(
      `
      ${FEED_IMAGE_SELECT_SQL}
      WHERE ${VISIBLE_IMAGE_WHERE_SQL}
        AND strftime('%m-%d', ${EFFECTIVE_FEED_TIME_SQL} / 1000, 'unixepoch', 'localtime') IN (${placeholders})
        AND CAST(strftime('%Y', ${EFFECTIVE_FEED_TIME_SQL} / 1000, 'unixepoch', 'localtime') AS INTEGER) < ?
      ORDER BY ${EFFECTIVE_FEED_TIME_SQL} DESC, images.sort_timestamp DESC, images.id DESC
      LIMIT ? OFFSET ?
      `
    ).all(...monthDayKeys, maxYearExclusive, limit, offset) as unknown as FeedImage[];
  },

  countByEffectiveTimeRange(startTimestamp: number, endTimestamp: number): number {
    return Number(
      (
        database
          .prepare(
            `
            SELECT COUNT(*) AS count
            FROM images
            WHERE ${VISIBLE_IMAGE_WHERE_UNSCOPED_SQL}
              AND ${EFFECTIVE_FEED_TIME_SQL} BETWEEN ? AND ?
            `
          )
          .get(startTimestamp, endTimestamp) as { count: number }
      ).count
    );
  },

  listByEffectiveTimeRange(startTimestamp: number, endTimestamp: number, page: number, limit: number): FeedImage[] {
    const offset = (page - 1) * limit;

    return database.prepare(
      `
      ${FEED_IMAGE_SELECT_SQL}
      WHERE ${VISIBLE_IMAGE_WHERE_SQL}
        AND ${EFFECTIVE_FEED_TIME_SQL} BETWEEN ? AND ?
      ORDER BY ${EFFECTIVE_FEED_TIME_SQL} DESC, images.sort_timestamp DESC, images.id DESC
      LIMIT ? OFFSET ?
      `
    ).all(startTimestamp, endTimestamp, limit, offset) as unknown as FeedImage[];
  },

  listFolderImages(
    folderId: number,
    page: number,
    limit: number,
    mediaType?: MediaType,
    order: FolderImageOrder = 'newest'
  ): FeedImage[] {
    const offset = (page - 1) * limit;
    const mediaTypeClause = mediaType ? ' AND images.media_type = ?' : '';
    const orderBySql = getQualifiedFolderImageOrderSql(order);
    return database.prepare(
      `
      ${FEED_IMAGE_SELECT_SQL}
      WHERE images.folder_id = ? AND ${VISIBLE_IMAGE_WHERE_SQL}${mediaTypeClause}
      ORDER BY ${orderBySql}
      LIMIT ? OFFSET ?
      `
    ).all(...(mediaType ? [folderId, mediaType, limit, offset] : [folderId, limit, offset])) as unknown as FeedImage[];
  },

  listPlaceImages(placeId: number, page: number, limit: number, mediaType?: MediaType): FeedImage[] {
    const offset = (page - 1) * limit;
    const mediaTypeClause = mediaType ? ' AND images.media_type = ?' : '';
    return database.prepare(
      `
      ${FEED_IMAGE_SELECT_SQL}
      WHERE images.place_id = ? AND ${VISIBLE_IMAGE_WHERE_SQL}${mediaTypeClause}
      ORDER BY images.sort_timestamp DESC, images.id DESC
      LIMIT ? OFFSET ?
      `
    ).all(...(mediaType ? [placeId, mediaType, limit, offset] : [placeId, limit, offset])) as unknown as FeedImage[];
  },

  listStoryFolderImages(folderId: number, page: number, limit: number, mediaType?: MediaType): FeedImage[] {
    const offset = (page - 1) * limit;
    const mediaTypeClause = mediaType ? ' AND images.media_type = ?' : '';
    return database.prepare(
      `
      ${FEED_IMAGE_SELECT_SQL}
      WHERE images.folder_id = ? AND ${STORY_IMAGE_WHERE_SQL}${mediaTypeClause}
      ORDER BY images.sort_timestamp DESC, images.id DESC
      LIMIT ? OFFSET ?
      `
    ).all(...(mediaType ? [folderId, mediaType, limit, offset] : [folderId, limit, offset])) as unknown as FeedImage[];
  },

  listStoryCapsuleImagesByOwnerFolder(ownerFolderId: number, page: number, limit: number, mediaType?: MediaType): FeedImage[] {
    const offset = (page - 1) * limit;
    const mediaTypeClause = mediaType ? ' AND images.media_type = ?' : '';
    return database.prepare(
      `
      ${FEED_IMAGE_SELECT_SQL}
      WHERE folders.story_owner_folder_id = ?
        AND folders.role = 'story_capsule'
        AND ${STORY_IMAGE_WHERE_SQL}${mediaTypeClause}
      ORDER BY ${EFFECTIVE_FEED_TIME_SQL} DESC, images.sort_timestamp DESC, images.id DESC
      LIMIT ? OFFSET ?
      `
    ).all(...(mediaType ? [ownerFolderId, mediaType, limit, offset] : [ownerFolderId, limit, offset])) as unknown as FeedImage[];
  },

  listTrashed(page: number, limit: number): TrashImage[] {
    const offset = (page - 1) * limit;
    return database.prepare(
      `
      SELECT
        images.id,
        images.folder_id AS folderId,
        folders.slug AS folderSlug,
        folders.name AS folderName,
        folders.folder_path AS folderPath,
        images.filename,
        images.caption AS caption,
        images.width,
        images.height,
        images.media_type AS mediaType,
        images.duration_ms AS durationMs,
        images.is_animated AS isAnimated,
        images.thumbnail_path AS thumbnailUrl,
        images.preview_path AS previewUrl,
        images.playback_strategy AS playbackStrategy,
        images.sort_timestamp AS sortTimestamp,
        images.taken_at AS takenAt,
        ${IMAGE_SAVED_SELECT_SQL},
        images.trashed_at AS trashedAt,
        places.id AS placeId,
        places.slug AS placeSlug,
        places.display_name AS placeName,
        places.kind AS placeKind,
        places.is_approximate AS placeIsApproximate
      FROM images
      INNER JOIN folders ON folders.id = images.folder_id
      LEFT JOIN places ON places.id = images.place_id
      WHERE images.is_deleted = 0 AND images.is_trashed = 1
      ORDER BY images.trashed_at DESC, images.id DESC
      LIMIT ? OFFSET ?
      `
    ).all(limit, offset) as unknown as TrashImage[];
  },

  countTrashed(): number {
    return Number(
      (database.prepare('SELECT COUNT(*) AS count FROM images WHERE is_deleted = 0 AND is_trashed = 1').get() as { count: number }).count
    );
  },

  countByFolder(folderId: number, mediaType?: MediaType): number {
    const mediaTypeClause = mediaType ? ' AND media_type = ?' : '';
    return Number(
      (
        database
          .prepare(`SELECT COUNT(*) AS count FROM images WHERE folder_id = ? AND is_deleted = 0${mediaTypeClause}`)
          .get(...(mediaType ? [folderId, mediaType] : [folderId])) as { count: number }
      ).count
    );
  },

  countVisibleByFolder(folderId: number, mediaType?: MediaType): number {
    const mediaTypeClause = mediaType ? ' AND media_type = ?' : '';
    return Number(
      (
        database
          .prepare(`SELECT COUNT(*) AS count FROM images WHERE folder_id = ? AND ${VISIBLE_IMAGE_WHERE_UNSCOPED_SQL}${mediaTypeClause}`)
          .get(...(mediaType ? [folderId, mediaType] : [folderId])) as { count: number }
      ).count
    );
  },

  countStoryMediaByFolder(folderId: number, mediaType?: MediaType): number {
    const mediaTypeClause = mediaType ? ' AND media_type = ?' : '';
    return Number(
      (
        database
          .prepare(`SELECT COUNT(*) AS count FROM images WHERE folder_id = ? AND ${STORY_IMAGE_WHERE_UNSCOPED_SQL}${mediaTypeClause}`)
          .get(...(mediaType ? [folderId, mediaType] : [folderId])) as { count: number }
      ).count
    );
  },

  countStoryCapsuleMediaByOwnerFolder(ownerFolderId: number, mediaType?: MediaType): number {
    const mediaTypeClause = mediaType ? ' AND images.media_type = ?' : '';
    return Number(
      (
        database
          .prepare(
            `
            SELECT COUNT(*) AS count
            FROM images
            INNER JOIN folders ON folders.id = images.folder_id
            WHERE folders.story_owner_folder_id = ?
              AND folders.role = 'story_capsule'
              AND ${STORY_IMAGE_WHERE_SQL}${mediaTypeClause}
            `
          )
          .get(...(mediaType ? [ownerFolderId, mediaType] : [ownerFolderId])) as { count: number }
      ).count
    );
  },

  listActiveByFolder(folderId: number): ImageRecord[] {
    return database
      .prepare('SELECT * FROM images WHERE folder_id = ? AND is_deleted = 0 ORDER BY id ASC')
      .all(folderId) as unknown as ImageRecord[];
  },

  listActive(): ImageRecord[] {
    return database
      .prepare('SELECT * FROM images WHERE is_deleted = 0 ORDER BY folder_id ASC, sort_timestamp DESC, id DESC')
      .all() as unknown as ImageRecord[];
  },

  refreshAbsolutePathsForGalleryRoot(galleryRoot: string): number {
    const rows = database
      .prepare('SELECT id, relative_path, absolute_path FROM images WHERE is_deleted = 0 ORDER BY id ASC')
      .all() as Array<Pick<ImageRecord, 'id' | 'relative_path' | 'absolute_path'>>;
    const update = database.prepare('UPDATE images SET absolute_path = ?, updated_at = ? WHERE id = ?');
    const updatedAt = nowIso();
    let refreshed = 0;

    for (const row of rows) {
      const nextAbsolutePath = safeJoin(galleryRoot, row.relative_path);

      if (normalizePath(row.absolute_path) === normalizePath(nextAbsolutePath)) {
        continue;
      }

      const result = update.run(nextAbsolutePath, updatedAt, row.id);
      refreshed += Number(result.changes ?? 0);
    }

    return refreshed;
  },

  listByIdRange(afterId: number, limit: number): ImageRecord[] {
    return database
      .prepare('SELECT * FROM images WHERE id > ? ORDER BY id ASC LIMIT ?')
      .all(afterId, limit) as unknown as ImageRecord[];
  },

  listWithExifForPlaceRebuild(afterId: number, limit: number): ImageRecord[] {
    return database
      .prepare(
        `
        SELECT *
        FROM images
        WHERE id > ? AND is_deleted = 0 AND exif_json IS NOT NULL
        ORDER BY id ASC
        LIMIT ?
        `
      )
      .all(afterId, limit) as unknown as ImageRecord[];
  },

  countAll(): number {
    return Number((database.prepare('SELECT COUNT(*) AS count FROM images').get() as { count: number }).count);
  },

  countUpToId(id: number): number {
    return Number((database.prepare('SELECT COUNT(*) AS count FROM images WHERE id <= ?').get(id) as { count: number }).count);
  },

  countMissingAssetKeys(): number {
    return Number(
      (database.prepare('SELECT COUNT(*) AS count FROM images WHERE asset_key IS NULL OR asset_key = \'\'').get() as { count: number }).count
    );
  },

  countPendingDerivativeMigrationRows(): number {
    return Number(
      (
        database
          .prepare(
            `
            SELECT COUNT(*) AS count
            FROM images
            WHERE asset_key IS NULL
              OR TRIM(asset_key) = ''
              OR LOWER(thumbnail_path) != LOWER(SUBSTR(TRIM(asset_key), 1, 2) || '/' || LOWER(TRIM(asset_key)) || '.webp')
              OR LOWER(preview_path) != LOWER(
                SUBSTR(TRIM(asset_key), 1, 2)
                || '/'
                || LOWER(TRIM(asset_key))
                || CASE WHEN media_type = 'video' THEN '.mp4' ELSE '.webp' END
              )
            `
          )
          .get() as { count: number }
      ).count
    );
  },

  countMissingTimestampMetadataByFolder(folderId: number): number {
    return Number(
      (
        database
          .prepare(
            'SELECT COUNT(*) AS count FROM images WHERE folder_id = ? AND is_deleted = 0 AND (taken_at IS NULL OR taken_at_source IS NULL)'
          )
          .get(folderId) as { count: number }
      ).count
    );
  },

  countMissingPlaybackStrategyByFolder(folderId: number): number {
    return Number(
      (
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM images WHERE folder_id = ? AND is_deleted = 0 AND media_type = 'video' AND (playback_strategy IS NULL OR playback_strategy = '')"
          )
          .get(folderId) as { count: number }
      ).count
    );
  },

  countByTakenAtSource(source: TakenAtSource): number {
    return Number(
      (
        database
          .prepare(`SELECT COUNT(*) AS count FROM images WHERE ${VISIBLE_IMAGE_WHERE_UNSCOPED_SQL} AND taken_at_source = ?`)
          .get(source) as { count: number }
      ).count
    );
  },

  getLatestFolderImageId(folderId: number): number | null {
    const row = database.prepare(
      `SELECT id FROM images WHERE folder_id = ? AND ${VISIBLE_IMAGE_WHERE_UNSCOPED_SQL} ORDER BY sort_timestamp DESC, id DESC LIMIT 1`
    ).get(folderId) as { id: number } | undefined;
    return row?.id ?? null;
  },

  getLatestStoryImageId(folderId: number): number | null {
    const row = database.prepare(
      `SELECT id FROM images WHERE folder_id = ? AND ${STORY_IMAGE_WHERE_UNSCOPED_SQL} ORDER BY sort_timestamp DESC, id DESC LIMIT 1`
    ).get(folderId) as { id: number } | undefined;
    return row?.id ?? null;
  },

  getLatestEffectiveTimestampByFolder(folderId: number): number | null {
    const row = database.prepare(
      `SELECT MAX(COALESCE(taken_at, sort_timestamp)) AS latestTimestamp FROM images WHERE folder_id = ? AND ${STORY_IMAGE_WHERE_UNSCOPED_SQL}`
    ).get(folderId) as { latestTimestamp: number | null } | undefined;
    return row?.latestTimestamp ?? null;
  },

  getExplicitCoverImageId(folderId: number): number | null {
    const row = database.prepare(
      `
      SELECT id
      FROM images
      WHERE folder_id = ?
        AND is_deleted = 0
        AND is_trashed = 0
        AND LOWER(filename) IN (${COVER_FILENAME_SQL})
      ORDER BY
        CASE LOWER(filename)
          WHEN 'cover.jpg' THEN 1
          WHEN 'cover.jpeg' THEN 2
          WHEN 'cover.png' THEN 3
          WHEN 'cover.webp' THEN 4
          WHEN 'cover.avif' THEN 5
          WHEN 'cover.gif' THEN 6
          ELSE 7
        END,
        id ASC
      LIMIT 1
      `
    ).get(folderId) as { id: number } | undefined;

    return row?.id ?? null;
  },

  getImageDetail(
    id: number,
    mediaType?: MediaType,
    allowHiddenCover = false,
    folderImageOrder: FolderImageOrder = 'newest'
  ): ImageDetail | undefined {
    const whereClause = allowHiddenCover ? 'images.is_deleted = 0 AND images.is_trashed = 0' : VISIBLE_IMAGE_WHERE_SQL;
    const nextComparisonSql = folderImageOrder === 'oldest'
      ? '(sort_timestamp > ? OR (sort_timestamp = ? AND id > ?))'
      : '(sort_timestamp < ? OR (sort_timestamp = ? AND id < ?))';
    const previousComparisonSql = folderImageOrder === 'oldest'
      ? '(sort_timestamp < ? OR (sort_timestamp = ? AND id < ?))'
      : '(sort_timestamp > ? OR (sort_timestamp = ? AND id > ?))';
    const nextOrderSql = getUnscopedFolderImageOrderSql(folderImageOrder);
    const previousOrderSql = getUnscopedFolderImageOrderSql(folderImageOrder === 'oldest' ? 'newest' : 'oldest');
    const detail = database.prepare(
      `
      SELECT
        images.id,
        images.folder_id AS folderId,
        folders.slug AS folderSlug,
        folders.name AS folderName,
        folders.folder_path AS folderPath,
        folders.avatar_image_id AS folderAvatarImageId,
        images.filename,
        images.caption AS caption,
        images.width,
        images.height,
        images.media_type AS mediaType,
        images.duration_ms AS durationMs,
        images.is_animated AS isAnimated,
        images.relative_path AS relativePath,
        images.mime_type AS mimeType,
        images.file_size AS fileSize,
        images.thumbnail_path AS thumbnailUrl,
        images.preview_path AS previewUrl,
        images.playback_strategy AS playbackStrategy,
        images.exif_json AS exifJson,
        images.absolute_path AS originalUrl,
        images.sort_timestamp AS sortTimestamp,
        images.taken_at AS takenAt,
        ${IMAGE_SAVED_SELECT_SQL},
        places.id AS placeId,
        places.slug AS placeSlug,
        places.display_name AS placeName,
        places.kind AS placeKind,
        places.is_approximate AS placeIsApproximate
      FROM images
      INNER JOIN folders ON folders.id = images.folder_id
      LEFT JOIN places ON places.id = images.place_id
      WHERE images.id = ? AND ${whereClause}
      `
    ).get(id) as (Omit<ImageDetail, 'nextImageId' | 'previousImageId' | 'exif'> & { originalUrl: string; exifJson: string | null }) | undefined;

    if (!detail || (mediaType && detail.mediaType !== mediaType)) {
      return undefined;
    }

    const mediaTypeClause = mediaType ? ' AND media_type = ?' : '';
    const next = database.prepare(
      `
      SELECT id
      FROM images
      WHERE folder_id = ? AND ${VISIBLE_IMAGE_WHERE_UNSCOPED_SQL}
        ${mediaTypeClause}
        AND ${nextComparisonSql}
      ORDER BY ${nextOrderSql}
      LIMIT 1
      `
    ).get(...(mediaType
      ? [detail.folderId, mediaType, detail.sortTimestamp, detail.sortTimestamp, detail.id]
      : [detail.folderId, detail.sortTimestamp, detail.sortTimestamp, detail.id])) as { id: number } | undefined;

    const previous = database.prepare(
      `
      SELECT id
      FROM images
      WHERE folder_id = ? AND ${VISIBLE_IMAGE_WHERE_UNSCOPED_SQL}
        ${mediaTypeClause}
        AND ${previousComparisonSql}
      ORDER BY ${previousOrderSql}
      LIMIT 1
      `
    ).get(...(mediaType
      ? [detail.folderId, mediaType, detail.sortTimestamp, detail.sortTimestamp, detail.id]
      : [detail.folderId, detail.sortTimestamp, detail.sortTimestamp, detail.id])) as { id: number } | undefined;

    return {
      ...detail,
      exif: null,
      nextImageId: next?.id ?? null,
      previousImageId: previous?.id ?? null
    };
  },

  countDeleted(): number {
    return Number((database.prepare('SELECT COUNT(*) AS count FROM images WHERE is_deleted = 1').get() as { count: number }).count);
  },

  listMoveCandidates(fileSize: number, mtimeMs: number, extension: string): ImageRecord[] {
    return database.prepare(
      `
      SELECT *
      FROM images
      WHERE file_size = ?
        AND ROUND(mtime_ms) = ?
        AND LOWER(extension) = LOWER(?)
        AND is_deleted = 0
        AND is_trashed = 0
      ORDER BY id ASC
      `
    ).all(fileSize, Math.round(mtimeMs), extension) as unknown as ImageRecord[];
  },

  listSoftDeletedDerivativeCandidates(cutoffIso: string): Array<Pick<ImageRecord, 'id' | 'thumbnail_path' | 'preview_path'>> {
    return database.prepare(
      `
      SELECT id, thumbnail_path, preview_path
      FROM images
      WHERE is_deleted = 1
        AND deleted_at IS NOT NULL
        AND deleted_at <= ?
      ORDER BY id ASC
      `
    ).all(cutoffIso) as Array<Pick<ImageRecord, 'id' | 'thumbnail_path' | 'preview_path'>>;
  },

  listAllDerivativePaths(): Array<Pick<ImageRecord, 'thumbnail_path' | 'preview_path'>> {
    return database.prepare('SELECT thumbnail_path, preview_path FROM images').all() as Array<Pick<ImageRecord, 'thumbnail_path' | 'preview_path'>>;
  },

  listDerivativeReferences(): Array<Pick<ImageRecord, 'thumbnail_path' | 'preview_path' | 'is_deleted' | 'deleted_at'>> {
    return database
      .prepare('SELECT thumbnail_path, preview_path, is_deleted, deleted_at FROM images')
      .all() as Array<Pick<ImageRecord, 'thumbnail_path' | 'preview_path' | 'is_deleted' | 'deleted_at'>>;
  },

  countByMediaType(mediaType: MediaType): number {
    return Number(
      (
        database
          .prepare(`SELECT COUNT(*) AS count FROM images WHERE ${VISIBLE_IMAGE_WHERE_UNSCOPED_SQL} AND media_type = ?`)
          .get(mediaType) as { count: number }
      ).count
    );
  },

  countWithThumbnail(): number {
    return Number(
      (
        database
          .prepare(`SELECT COUNT(*) AS count FROM images WHERE ${VISIBLE_IMAGE_WHERE_UNSCOPED_SQL} AND thumbnail_path IS NOT NULL`)
          .get() as { count: number }
      ).count
    );
  },

  countWithPreview(): number {
    return Number(
      (
        database
          .prepare(`SELECT COUNT(*) AS count FROM images WHERE ${VISIBLE_IMAGE_WHERE_UNSCOPED_SQL} AND preview_path IS NOT NULL`)
          .get() as { count: number }
      ).count
    );
  },

  getByThumbnailPath(thumbnailPath: string): ImageRecord | undefined {
    return database.prepare('SELECT * FROM images WHERE thumbnail_path = ? AND is_deleted = 0 LIMIT 1').get(thumbnailPath) as ImageRecord | undefined;
  },

  getByPreviewPath(previewPath: string): ImageRecord | undefined {
    return database.prepare('SELECT * FROM images WHERE preview_path = ? AND is_deleted = 0 LIMIT 1').get(previewPath) as ImageRecord | undefined;
  }
};

export const likeRepository = {
  getByImageId(imageId: number): LikeRecord | undefined {
    return database.prepare('SELECT * FROM likes WHERE image_id = ?').get(imageId) as LikeRecord | undefined;
  },

  listLikedImages(): FeedImage[] {
    return database.prepare(
      `
      SELECT
        images.id,
        images.folder_id AS folderId,
        folders.slug AS folderSlug,
        folders.name AS folderName,
        folders.folder_path AS folderPath,
        images.filename,
        images.caption AS caption,
        images.width,
        images.height,
        images.media_type AS mediaType,
        images.duration_ms AS durationMs,
        images.is_animated AS isAnimated,
        images.thumbnail_path AS thumbnailUrl,
        images.preview_path AS previewUrl,
        images.playback_strategy AS playbackStrategy,
        images.sort_timestamp AS sortTimestamp,
        images.taken_at AS takenAt,
        ${IMAGE_SAVED_SELECT_SQL}
      FROM likes
      INNER JOIN images ON images.id = likes.image_id
      INNER JOIN folders ON folders.id = images.folder_id
      WHERE ${VISIBLE_IMAGE_WHERE_SQL}
      ORDER BY likes.created_at DESC, likes.image_id DESC
      `
    ).all() as unknown as FeedImage[];
  },

  countLikedOlderThan(cutoffTimestamp: number): number {
    return Number(
      (
        database
          .prepare(
            `
            SELECT COUNT(*) AS count
            FROM likes
            INNER JOIN images ON images.id = likes.image_id
            INNER JOIN folders ON folders.id = images.folder_id
            WHERE ${VISIBLE_IMAGE_WHERE_SQL} AND ${EFFECTIVE_FEED_TIME_SQL} <= ?
            `
          )
          .get(cutoffTimestamp) as { count: number }
      ).count
    );
  },

  listLikedOlderThan(page: number, limit: number, cutoffTimestamp: number): FeedImage[] {
    const offset = (page - 1) * limit;

    return database.prepare(
      `
      SELECT
        images.id,
        images.folder_id AS folderId,
        folders.slug AS folderSlug,
        folders.name AS folderName,
        folders.folder_path AS folderPath,
        images.filename,
        images.caption AS caption,
        images.width,
        images.height,
        images.media_type AS mediaType,
        images.duration_ms AS durationMs,
        images.is_animated AS isAnimated,
        images.thumbnail_path AS thumbnailUrl,
        images.preview_path AS previewUrl,
        images.playback_strategy AS playbackStrategy,
        images.sort_timestamp AS sortTimestamp,
        images.taken_at AS takenAt,
        ${IMAGE_SAVED_SELECT_SQL}
      FROM likes
      INNER JOIN images ON images.id = likes.image_id
      INNER JOIN folders ON folders.id = images.folder_id
      WHERE ${VISIBLE_IMAGE_WHERE_SQL} AND ${EFFECTIVE_FEED_TIME_SQL} <= ?
      ORDER BY likes.created_at DESC, likes.image_id DESC
      LIMIT ? OFFSET ?
      `
    ).all(cutoffTimestamp, limit, offset) as unknown as FeedImage[];
  },

  upsert(imageId: number): LikeRecord {
    database.prepare(
      `
      INSERT INTO likes (image_id, created_at)
      VALUES (?, ?)
      ON CONFLICT(image_id) DO UPDATE SET
        created_at = excluded.created_at
      `
    ).run(imageId, nowIso());

    return this.getByImageId(imageId) as LikeRecord;
  },

  remove(imageId: number): boolean {
    const result = database.prepare('DELETE FROM likes WHERE image_id = ?').run(imageId);
    return Number(result.changes ?? 0) > 0;
  },

  removeByFolder(folderId: number): number {
    const result = database.prepare(
      'DELETE FROM likes WHERE image_id IN (SELECT id FROM images WHERE folder_id = ?)'
    ).run(folderId);
    return Number(result.changes ?? 0);
  }
};

export const collectionRepository = {
  ensureDefaultCollection(): CollectionRecord {
    const existingDefault = database.prepare('SELECT * FROM collections WHERE is_default = 1 LIMIT 1').get() as CollectionRecord | undefined;
    if (existingDefault) {
      if (existingDefault.name !== DEFAULT_COLLECTION_NAME) {
        database.prepare('UPDATE collections SET name = ?, updated_at = ? WHERE id = ?').run(DEFAULT_COLLECTION_NAME, nowIso(), existingDefault.id);
      }

      return this.getById(existingDefault.id) as CollectionRecord;
    }

    const savedCollection = this.getBySlug(DEFAULT_COLLECTION_SLUG);
    if (savedCollection) {
      database
        .prepare('UPDATE collections SET name = ?, is_default = 1, updated_at = ? WHERE id = ?')
        .run(DEFAULT_COLLECTION_NAME, nowIso(), savedCollection.id);
      return this.getById(savedCollection.id) as CollectionRecord;
    }

    database
      .prepare('INSERT INTO collections (slug, name, is_default, created_at, updated_at) VALUES (?, ?, 1, ?, ?)')
      .run(DEFAULT_COLLECTION_SLUG, DEFAULT_COLLECTION_NAME, nowIso(), nowIso());

    return this.getBySlug(DEFAULT_COLLECTION_SLUG) as CollectionRecord;
  },

  getById(id: number): CollectionRecord | undefined {
    return database.prepare('SELECT * FROM collections WHERE id = ?').get(id) as CollectionRecord | undefined;
  },

  getDefaultCollection(): CollectionRecord {
    return this.ensureDefaultCollection();
  },

  repairDefaultMemberships(): number {
    const defaultCollection = this.ensureDefaultCollection();
    const timestamp = nowIso();
    const result = database
      .prepare(
        `
        INSERT OR IGNORE INTO collection_items (collection_id, image_id, created_at)
        SELECT ?, custom_items.image_id, ?
        FROM collection_items AS custom_items
        INNER JOIN collections AS custom_collections ON custom_collections.id = custom_items.collection_id
        LEFT JOIN collection_items AS default_items
          ON default_items.collection_id = ? AND default_items.image_id = custom_items.image_id
        WHERE custom_collections.is_default = 0
          AND default_items.image_id IS NULL
        `
      )
      .run(defaultCollection.id, timestamp, defaultCollection.id);

    const repairedCount = Number(result.changes ?? 0);
    if (repairedCount > 0) {
      database.prepare('UPDATE collections SET updated_at = ? WHERE id = ?').run(timestamp, defaultCollection.id);
    }

    return repairedCount;
  },

  getBySlug(slug: string): CollectionRecord | undefined {
    return database.prepare('SELECT * FROM collections WHERE slug = ?').get(slug) as CollectionRecord | undefined;
  },

  create(name: string): CollectionRecord {
    this.ensureDefaultCollection();
    const normalizedName = name.trim().toLocaleLowerCase();
    const existingName = database
      .prepare('SELECT id FROM collections WHERE LOWER(name) = ? LIMIT 1')
      .get(normalizedName) as { id: number } | undefined;
    if (existingName) {
      throw new Error('Collection name already exists.');
    }

    const existingSlugs = new Set((database.prepare('SELECT slug FROM collections').all() as Array<{ slug: string }>).map((row) => row.slug));
    const slug = resolveUniqueSlug(name, existingSlugs, slugifyFolderName);
    const timestamp = nowIso();

    database
      .prepare('INSERT INTO collections (slug, name, is_default, created_at, updated_at) VALUES (?, ?, 0, ?, ?)')
      .run(slug, name, timestamp, timestamp);

    return this.getBySlug(slug) as CollectionRecord;
  },

  updateName(slug: string, name: string): CollectionRecord | undefined {
    this.ensureDefaultCollection();
    const collection = this.getBySlug(slug);
    if (!collection || collection.is_default === 1) {
      return undefined;
    }

    const normalizedName = name.trim().toLocaleLowerCase();
    const existingName = database
      .prepare('SELECT id FROM collections WHERE LOWER(name) = ? AND id != ? LIMIT 1')
      .get(normalizedName, collection.id) as { id: number } | undefined;
    if (existingName) {
      throw new Error('Collection name already exists.');
    }

    database
      .prepare('UPDATE collections SET name = ?, updated_at = ? WHERE id = ?')
      .run(name.trim(), nowIso(), collection.id);

    return this.getById(collection.id);
  },

  delete(slug: string): CollectionRecord | undefined {
    const collection = this.getBySlug(slug);
    if (!collection || collection.is_default === 1) {
      return undefined;
    }

    database.prepare('DELETE FROM collections WHERE id = ?').run(collection.id);

    return collection;
  },

  listSummaries(): CollectionSummaryRecord[] {
    this.ensureDefaultCollection();
    return database
      .prepare(
        `
        SELECT
          collections.*,
          (
            SELECT COUNT(*)
            FROM collection_items
            INNER JOIN images ON images.id = collection_items.image_id
            INNER JOIN folders ON folders.id = images.folder_id
            WHERE collection_items.collection_id = collections.id AND ${VISIBLE_IMAGE_WHERE_SQL}
          ) AS item_count,
          (
            SELECT images.id
            FROM collection_items
            INNER JOIN images ON images.id = collection_items.image_id
            INNER JOIN folders ON folders.id = images.folder_id
            WHERE collection_items.collection_id = collections.id AND ${VISIBLE_IMAGE_WHERE_SQL}
            ORDER BY collection_items.created_at DESC, collection_items.image_id DESC
            LIMIT 1
          ) AS cover_image_id,
          (
            SELECT images.thumbnail_path
            FROM collection_items
            INNER JOIN images ON images.id = collection_items.image_id
            INNER JOIN folders ON folders.id = images.folder_id
            WHERE collection_items.collection_id = collections.id AND ${VISIBLE_IMAGE_WHERE_SQL}
            ORDER BY collection_items.created_at DESC, collection_items.image_id DESC
            LIMIT 1
          ) AS cover_thumbnail_path,
          (
            SELECT GROUP_CONCAT(preview_images.image_id)
            FROM (
              SELECT collection_items.image_id
              FROM collection_items
              INNER JOIN images ON images.id = collection_items.image_id
              INNER JOIN folders ON folders.id = images.folder_id
              WHERE collection_items.collection_id = collections.id AND ${VISIBLE_IMAGE_WHERE_SQL}
              ORDER BY collection_items.created_at DESC, collection_items.image_id DESC
              LIMIT 4
            ) AS preview_images
          ) AS preview_image_ids
        FROM collections
        ORDER BY collections.is_default DESC, collections.updated_at DESC, collections.id DESC
        `
      )
      .all() as unknown as CollectionSummaryRecord[];
  },

  listMembershipsForImage(imageId: number): CollectionMembershipRecord[] {
    this.ensureDefaultCollection();
    return database
      .prepare(
        `
        SELECT
          collections.*,
          (
            SELECT COUNT(*)
            FROM collection_items
            INNER JOIN images ON images.id = collection_items.image_id
            INNER JOIN folders ON folders.id = images.folder_id
            WHERE collection_items.collection_id = collections.id AND ${VISIBLE_IMAGE_WHERE_SQL}
          ) AS item_count,
          (
            SELECT images.id
            FROM collection_items
            INNER JOIN images ON images.id = collection_items.image_id
            INNER JOIN folders ON folders.id = images.folder_id
            WHERE collection_items.collection_id = collections.id AND ${VISIBLE_IMAGE_WHERE_SQL}
            ORDER BY collection_items.created_at DESC, collection_items.image_id DESC
            LIMIT 1
          ) AS cover_image_id,
          (
            SELECT images.thumbnail_path
            FROM collection_items
            INNER JOIN images ON images.id = collection_items.image_id
            INNER JOIN folders ON folders.id = images.folder_id
            WHERE collection_items.collection_id = collections.id AND ${VISIBLE_IMAGE_WHERE_SQL}
            ORDER BY collection_items.created_at DESC, collection_items.image_id DESC
            LIMIT 1
          ) AS cover_thumbnail_path,
          (
            SELECT GROUP_CONCAT(preview_images.image_id)
            FROM (
              SELECT collection_items.image_id
              FROM collection_items
              INNER JOIN images ON images.id = collection_items.image_id
              INNER JOIN folders ON folders.id = images.folder_id
              WHERE collection_items.collection_id = collections.id AND ${VISIBLE_IMAGE_WHERE_SQL}
              ORDER BY collection_items.created_at DESC, collection_items.image_id DESC
              LIMIT 4
            ) AS preview_images
          ) AS preview_image_ids,
          CASE WHEN EXISTS (
            SELECT 1
            FROM collection_items
            WHERE collection_items.collection_id = collections.id
              AND collection_items.image_id = ?
          ) THEN 1 ELSE 0 END AS contains_image
        FROM collections
        ORDER BY collections.is_default DESC, collections.updated_at DESC, collections.id DESC
        `
      )
      .all(imageId) as unknown as CollectionMembershipRecord[];
  },

  listImages(slug: string, page: number, limit: number): FeedImage[] {
    this.ensureDefaultCollection();
    const offset = (page - 1) * limit;
    return database
      .prepare(
        `
        ${FEED_IMAGE_SELECT_SQL}
        INNER JOIN collection_items ON collection_items.image_id = images.id
        INNER JOIN collections ON collections.id = collection_items.collection_id
        WHERE collections.slug = ? AND ${VISIBLE_IMAGE_WHERE_SQL}
        ORDER BY collection_items.created_at DESC, collection_items.image_id DESC
        LIMIT ? OFFSET ?
        `
      )
      .all(slug, limit, offset) as unknown as FeedImage[];
  },

  countImages(slug: string): number {
    this.ensureDefaultCollection();
    return Number(
      (
        database
          .prepare(
            `
            SELECT COUNT(*) AS count
            FROM collection_items
            INNER JOIN collections ON collections.id = collection_items.collection_id
            INNER JOIN images ON images.id = collection_items.image_id
            INNER JOIN folders ON folders.id = images.folder_id
            WHERE collections.slug = ? AND ${VISIBLE_IMAGE_WHERE_SQL}
            `
          )
          .get(slug) as { count: number }
      ).count
    );
  },

  isImageSaved(imageId: number): boolean {
    this.ensureDefaultCollection();
    const row = database
      .prepare(
        `
        SELECT 1 AS found
        FROM collection_items
        INNER JOIN collections ON collections.id = collection_items.collection_id
        WHERE collections.is_default = 1 AND collection_items.image_id = ?
        LIMIT 1
        `
      )
      .get(imageId) as { found: number } | undefined;
    return row?.found === 1;
  },

  saveToDefault(imageId: number): CollectionRecord {
    const defaultCollection = this.ensureDefaultCollection();
    const timestamp = nowIso();

    database
      .prepare(
        `
        INSERT INTO collection_items (collection_id, image_id, created_at)
        VALUES (?, ?, ?)
        ON CONFLICT(collection_id, image_id) DO UPDATE SET
          created_at = excluded.created_at
        `
      )
      .run(defaultCollection.id, imageId, timestamp);
    database.prepare('UPDATE collections SET updated_at = ? WHERE id = ?').run(timestamp, defaultCollection.id);

    return this.getById(defaultCollection.id) as CollectionRecord;
  },

  unsaveEverywhere(imageId: number): void {
    const timestamp = nowIso();
    database
      .prepare(
        `
        UPDATE collections
        SET updated_at = ?
        WHERE id IN (
          SELECT collection_id
          FROM collection_items
          WHERE image_id = ?
        )
        `
      )
      .run(timestamp, imageId);
    database.prepare('DELETE FROM collection_items WHERE image_id = ?').run(imageId);
  },

  addImage(collectionSlug: string, imageId: number): CollectionRecord | undefined {
    const defaultCollection = this.ensureDefaultCollection();
    const collection = this.getBySlug(collectionSlug);
    if (!collection) {
      return undefined;
    }

    const timestamp = nowIso();
    if (collection.id !== defaultCollection.id) {
      const defaultInsertResult = database
        .prepare(
          `
          INSERT OR IGNORE INTO collection_items (collection_id, image_id, created_at)
          VALUES (?, ?, ?)
          `
        )
        .run(defaultCollection.id, imageId, timestamp);

      if (Number(defaultInsertResult.changes ?? 0) > 0) {
        database.prepare('UPDATE collections SET updated_at = ? WHERE id = ?').run(timestamp, defaultCollection.id);
      }
    }

    database
      .prepare(
        `
        INSERT INTO collection_items (collection_id, image_id, created_at)
        VALUES (?, ?, ?)
        ON CONFLICT(collection_id, image_id) DO UPDATE SET
          created_at = excluded.created_at
        `
      )
      .run(collection.id, imageId, timestamp);
    database.prepare('UPDATE collections SET updated_at = ? WHERE id = ?').run(timestamp, collection.id);

    return this.getById(collection.id);
  },

  removeImage(collectionSlug: string, imageId: number): CollectionRecord | undefined {
    this.ensureDefaultCollection();
    const collection = this.getBySlug(collectionSlug);
    if (!collection) {
      return undefined;
    }

    database.prepare('DELETE FROM collection_items WHERE collection_id = ? AND image_id = ?').run(collection.id, imageId);
    database.prepare('UPDATE collections SET updated_at = ? WHERE id = ?').run(nowIso(), collection.id);

    return this.getById(collection.id);
  },

  removeByFolder(folderId: number): number {
    const result = database.prepare(
      'DELETE FROM collection_items WHERE image_id IN (SELECT id FROM images WHERE folder_id = ?)'
    ).run(folderId);
    return Number(result.changes ?? 0);
  }
};

export const folderShareLinkRepository = {
  create(input: CreateFolderShareLinkInput): FolderShareLinkRecord {
    database
      .prepare(
        `
        INSERT INTO folder_share_links (
          folder_id,
          token_hash,
          token_prefix,
          expires_at,
          allow_original_downloads,
          created_at
        )
        VALUES (?, ?, ?, ?, 0, ?)
        `
      )
      .run(
        input.folderId,
        input.tokenHash,
        input.tokenPrefix,
        input.expiresAt,
        nowIso()
      );

    return this.getByTokenHash(input.tokenHash) as FolderShareLinkRecord;
  },

  getById(id: number): FolderShareLinkRecord | undefined {
    return database.prepare('SELECT * FROM folder_share_links WHERE id = ?').get(id) as FolderShareLinkRecord | undefined;
  },

  getByTokenHash(tokenHash: string): FolderShareLinkRecord | undefined {
    return database
      .prepare('SELECT * FROM folder_share_links WHERE token_hash = ?')
      .get(tokenHash) as FolderShareLinkRecord | undefined;
  },

  listByFolder(folderId: number): FolderShareLinkRecord[] {
    return database
      .prepare(
        `
        SELECT *
        FROM folder_share_links
        WHERE folder_id = ?
        ORDER BY created_at DESC, id DESC
        `
      )
      .all(folderId) as unknown as FolderShareLinkRecord[];
  },

  revoke(id: number, folderId: number): FolderShareLinkRecord | undefined {
    const revokedAt = nowIso();
    database
      .prepare(
        `
        UPDATE folder_share_links
        SET revoked_at = COALESCE(revoked_at, ?)
        WHERE id = ? AND folder_id = ?
        `
      )
      .run(revokedAt, id, folderId);

    return this.getById(id);
  },

  touchLastUsed(id: number): void {
    database.prepare('UPDATE folder_share_links SET last_used_at = ? WHERE id = ?').run(nowIso(), id);
  }
};

export const folderSharePasswordRepository = {
  get(folderId: number): FolderSharePasswordRecord | undefined {
    return database
      .prepare('SELECT * FROM folder_share_passwords WHERE folder_id = ?')
      .get(folderId) as FolderSharePasswordRecord | undefined;
  },

  upsert(input: UpsertFolderSharePasswordInput): FolderSharePasswordRecord {
    database.exec('BEGIN TRANSACTION;');
    try {
      database.prepare('UPDATE folders SET share_password_version = share_password_version + 1 WHERE id = ?').run(input.folderId);
      const folder = database.prepare('SELECT share_password_version FROM folders WHERE id = ?').get(input.folderId) as { share_password_version: number } | undefined;
      const version = folder ? folder.share_password_version : 1;

      database
        .prepare(
          `
          INSERT INTO folder_share_passwords (
            folder_id,
            password_hash,
            password_salt,
            version,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(folder_id) DO UPDATE SET
            password_hash = excluded.password_hash,
            password_salt = excluded.password_salt,
            version = excluded.version,
            updated_at = excluded.updated_at
          `
        )
        .run(input.folderId, input.passwordHash, input.passwordSalt, version, nowIso());

      database.exec('COMMIT;');
      return this.get(input.folderId) as FolderSharePasswordRecord;
    } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
    }
  },

  remove(folderId: number): boolean {
    database.exec('BEGIN TRANSACTION;');
    try {
      database.prepare('UPDATE folders SET share_password_version = share_password_version + 1 WHERE id = ?').run(folderId);
      const result = database.prepare('DELETE FROM folder_share_passwords WHERE folder_id = ?').run(folderId);
      database.exec('COMMIT;');
      return Number(result.changes ?? 0) > 0;
    } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
    }
  }
};

export const collectionConstants = {
  defaultCollectionSlug: DEFAULT_COLLECTION_SLUG,
  defaultCollectionName: DEFAULT_COLLECTION_NAME
} as const;

export const appSettingsRepository = {
  get(key: string): string | null {
    const row = database.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as Pick<AppSettingRecord, 'value'> | undefined;
    return row?.value ?? null;
  },

  set(key: string, value: string): void {
    database
      .prepare(
        `
        INSERT INTO app_settings (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `
      )
      .run(key, value);
  },

  remove(key: string): void {
    database.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
  }
};

export const maintenanceRepository = {
  resetLibraryIndex(): void {
    database.exec(`
      BEGIN;
      UPDATE folders SET avatar_image_id = NULL;
      DELETE FROM likes;
      DELETE FROM folder_share_passwords;
      DELETE FROM folder_share_links;
      DELETE FROM images;
      DELETE FROM folders;
      DELETE FROM folder_scan_state;
      DELETE FROM scan_runs;
      DELETE FROM app_settings WHERE key = '${SHARE_SESSION_SECRET_SETTING_KEY}';
      DELETE FROM sqlite_sequence WHERE name IN ('folders', 'images', 'scan_runs');
      COMMIT;
    `);
  }
};

export const folderScanStateRepository = {
  getAll(): FolderScanStateRecord[] {
    return database.prepare('SELECT * FROM folder_scan_state ORDER BY folder_path ASC').all() as unknown as FolderScanStateRecord[];
  },

  upsert(input: UpsertFolderScanStateInput): void {
    const normalizedFolderPath = normalizePath(input.folderPath);
    database
      .prepare(
        `
        INSERT INTO folder_scan_state (folder_path, signature, file_count, max_mtime_ms, total_size, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(folder_path) DO UPDATE SET
          signature = excluded.signature,
          file_count = excluded.file_count,
          max_mtime_ms = excluded.max_mtime_ms,
          total_size = excluded.total_size,
          updated_at = excluded.updated_at
        `
      )
      .run(normalizedFolderPath, input.signature, input.fileCount, input.maxMtimeMs, input.totalSize, nowIso());
  },

  delete(folderPath: string): number {
    const result = database.prepare('DELETE FROM folder_scan_state WHERE folder_path = ?').run(normalizePath(folderPath));
    return Number(result.changes ?? 0);
  },

  deleteTree(folderPath: string): number {
    const normalizedFolderPath = normalizePath(folderPath);
    const result = database
      .prepare('DELETE FROM folder_scan_state WHERE folder_path = ? OR folder_path LIKE ?')
      .run(normalizedFolderPath, `${normalizedFolderPath}/%`);
    return Number(result.changes ?? 0);
  },

  deleteMissing(activeFolderPaths: string[]): number {
    if (activeFolderPaths.length === 0) {
      const result = database.prepare('DELETE FROM folder_scan_state').run();
      return Number(result.changes ?? 0);
    }

    const normalizedFolderPaths = activeFolderPaths.map((folderPath) => normalizePath(folderPath));
    const placeholders = normalizedFolderPaths.map(() => '?').join(', ');
    const statement = database.prepare(`DELETE FROM folder_scan_state WHERE folder_path NOT IN (${placeholders})`);
    const result = statement.run(...normalizedFolderPaths);
    return Number(result.changes ?? 0);
  }
};

export const scanRunRepository = {
  start(): number {
    const startedAt = nowIso();
    const result = database
      .prepare('INSERT INTO scan_runs (started_at, status, scanned_files, new_files, updated_files, removed_files) VALUES (?, ?, 0, 0, 0, 0)')
      .run(startedAt, 'running');

    return Number(result.lastInsertRowid);
  },

  finish(runId: number, input: Omit<ScanRunRecord, 'id' | 'started_at'>): void {
    database.prepare(
      `
      UPDATE scan_runs
      SET finished_at = ?, status = ?, scanned_files = ?, new_files = ?, updated_files = ?, removed_files = ?, error_text = ?
      WHERE id = ?
      `
    ).run(input.finished_at, input.status, input.scanned_files, input.new_files, input.updated_files, input.removed_files, input.error_text, runId);
  },

  latest(): ScanRunRecord | undefined {
    return database.prepare('SELECT * FROM scan_runs ORDER BY id DESC LIMIT 1').get() as ScanRunRecord | undefined;
  },

  latestCompleted(): ScanRunRecord | undefined {
    return database
      .prepare('SELECT * FROM scan_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1')
      .get() as ScanRunRecord | undefined;
  }
};
