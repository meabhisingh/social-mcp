import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorMessage, localIdFrom } from "./errors.js";
import {
  cancelScheduled,
  getPost,
  listPublished,
  listScheduled,
  postInstagram,
  postX,
  postYouTube,
  runDuePosts,
  schedulePost,
} from "./posts.js";

const privacyStatus = z.enum(["public", "private", "unlisted"]);
const instagramKind = z.enum(["image", "reel", "story"]);

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "social-mcp", version: "1.0.0" },
    {
      instructions:
        "Publish and schedule posts to YouTube, Instagram, and X. Credentials come from the environment and are not stored. post_youtube, post_instagram, and post_x publish now. schedule_post saves a post until runAt. run_due_posts publishes due posts. list_scheduled_posts, get_post, cancel_scheduled_post, and list_published_posts use the local JSON store.",
    },
  );

  server.registerTool(
    "post_youtube",
    {
      title: "Post to YouTube",
      description:
        "Upload a local video with the YouTube Data API v3 resumable upload protocol and publish it now. Returns the YouTube video id and the local record id. Privacy defaults to private.",
      inputSchema: {
        title: z.string().min(1).max(100).describe("Video title, 1-100 characters."),
        content: z.string().max(5000).describe("Video description. May be empty.").default(""),
        mediaPath: z.string().min(1).describe("Path to a local video file."),
        privacyStatus: privacyStatus.describe("public, private, or unlisted. Defaults to private.").default("private"),
        categoryId: z.string().regex(/^\d{1,4}$/).describe("YouTube category id. Defaults to 22.").default("22"),
        tags: z.array(z.string()).max(30).optional().describe("Optional keyword tags."),
        madeForKids: z.boolean().describe("selfDeclaredMadeForKids. Defaults to false.").default(false),
      },
      annotations: { openWorldHint: true },
    },
    async (args) => guard(() => postYouTube(args)),
  );

  server.registerTool(
    "post_instagram",
    {
      title: "Post to Instagram",
      description:
        "Publish through the Instagram Graph API: create a media container, upload a local Reel with the resumable upload when needed, then call media_publish. Optional collaborators are invited on the container before publish. Photos need a public https image_url. Returns the Instagram media id, the local record id, and invitesSent.",
      inputSchema: {
        content: z.string().max(2200).describe("Caption, at most 2200 characters.").default(""),
        mediaPath: z.string().min(1).describe("Local video path, or a public https image or video URL."),
        mediaType: instagramKind.optional().describe("image, reel, or story. Inferred from the file when omitted."),
        shareToFeed: z.boolean().optional().describe("For Reels, also share to the feed. Defaults to true."),
        altText: z.string().max(1000).optional().describe("Alt text for a photo."),
        collaborators: z
          .array(z.string().min(1).max(31))
          .max(3)
          .optional()
          .describe("Instagram usernames to invite as collaborators. At most 3. Feed images and Reels only, not Stories. A leading @ is optional."),
      },
      annotations: { openWorldHint: true },
    },
    async (args) => guard(() => postInstagram(args)),
  );

  server.registerTool(
    "post_x",
    {
      title: "Post to X",
      description:
        "Publish a post with X API v2. Uploads media with the chunked media upload (INIT, APPEND, FINALIZE), then creates the post with POST /2/tweets. Returns the post id and the local record id. Text may be empty when media is present. Standard accounts are still limited to 280 characters by X.",
      inputSchema: {
        content: z.string().max(25000).describe("Post text. Required when mediaPath is omitted.").default(""),
        mediaPath: z.string().min(1).optional().describe("Optional local image or video path."),
      },
      annotations: { openWorldHint: true },
    },
    async (args) => guard(() => postX(args)),
  );

  server.registerTool(
    "schedule_post",
    {
      title: "Schedule post",
      description:
        "Save a post in the local store to publish at runAt. Does not call the platform. Requires platform, content, media path, and runAt.",
      inputSchema: {
        platform: z.enum(["youtube", "instagram", "x"]).describe("youtube, instagram, or x."),
        content: z.string().max(25000).describe("Caption, description, or post text."),
        mediaPath: z.string().min(1).describe("Local media path, or an https URL for Instagram."),
        runAt: z.string().datetime({ offset: true }).describe("ISO 8601 timestamp with a timezone, for example 2026-11-09T18:00:00Z."),
        title: z.string().max(100).optional().describe("Required for YouTube."),
        privacyStatus: privacyStatus.optional().describe("YouTube privacy. Defaults to private."),
        categoryId: z.string().regex(/^\d{1,4}$/).optional().describe("YouTube category id. Defaults to 22."),
        tags: z.array(z.string()).max(30).optional().describe("YouTube tags."),
        madeForKids: z.boolean().optional().describe("YouTube selfDeclaredMadeForKids."),
        mediaType: instagramKind.optional().describe("Instagram image, reel, or story."),
        shareToFeed: z.boolean().optional().describe("Share an Instagram Reel to the feed."),
        altText: z.string().max(1000).optional().describe("Instagram photo alt text."),
        collaborators: z
          .array(z.string().min(1).max(31))
          .max(3)
          .optional()
          .describe("Instagram usernames to invite when the scheduled post runs. At most 3. Ignored unless platform is instagram. Not supported for Stories."),
      },
    },
    async (args) => guard(() => schedulePost(args)),
  );

  server.registerTool(
    "list_scheduled_posts",
    {
      title: "List scheduled posts",
      description: "List posts in the local store that are still scheduled, soonest first.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Maximum rows. Defaults to 20."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => guard(() => listScheduled(args.limit ?? 20)),
  );

  server.registerTool(
    "get_post",
    {
      title: "Get post",
      description: "Get one post from the local store by its local record id.",
      inputSchema: {
        id: z.string().min(1).max(80).describe("Local record id."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => guard(() => getPost(args.id)),
  );

  server.registerTool(
    "cancel_scheduled_post",
    {
      title: "Cancel scheduled post",
      description: "Cancel one scheduled post that has not started publishing.",
      inputSchema: {
        id: z.string().min(1).max(80).describe("Local record id of a scheduled post."),
      },
      annotations: { destructiveHint: true },
    },
    async (args) => guard(() => cancelScheduled(args.id)),
  );

  server.registerTool(
    "run_due_posts",
    {
      title: "Run due posts",
      description:
        "Publish scheduled posts whose runAt is now or earlier, using the same YouTube, Instagram, and X flows as posting now. Returns each local record id and platform id.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional().describe("Maximum posts to publish this call. Defaults to 10."),
      },
      annotations: { openWorldHint: true },
    },
    async (args) => guard(() => runDuePosts({ limit: args.limit })),
  );

  server.registerTool(
    "list_published_posts",
    {
      title: "List published posts",
      description: "List recent posts from the local store that were published, newest first.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Maximum rows. Defaults to 20."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => guard(() => listPublished(args.limit ?? 20)),
  );

  return server;
}

async function guard(work: () => Promise<unknown>) {
  try {
    return jsonResult(await work());
  } catch (error) {
    return jsonResult({ id: localIdFrom(error), error: errorMessage(error) }, true);
  }
}

function jsonResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true as const } : {}),
  };
}
