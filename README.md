# social-mcp

Local [Model Context Protocol](https://modelcontextprotocol.io) server that publishes to YouTube, Instagram, and X over stdio. Posts are stored as JSON under `./data` (or `SOCIAL_MCP_DATA_DIR`). Media files you pass in are kept with that store. Platform credentials come from the environment only and are never written into `data/`.

This process does not deploy anywhere. It speaks MCP on stdin and stdout. Logs go to stderr.

## Build and run

Requires Node.js 22 or newer.

```bash
npm install
npm run build
npm start
```

`npm start` runs `node dist/index.js` and waits for a client. `npm run typecheck` runs the TypeScript compiler without emitting files.

Publish scheduled posts once:

```bash
npm run due
```

Watch and publish on an interval (default 30 seconds, override with `SOCIAL_MCP_POLL_MS`, minimum 5000):

```bash
npm run due -- --watch
```

The one-shot runner prints a JSON report to stdout and exits with status 1 if any due post failed. The server and the runner load a `.env` file from the working directory when a variable is not already set. Do not commit `.env`.

## Native binary

`npm run compile` builds one native executable with Node's single executable application flow (`node --experimental-sea-config`). The build machine needs Node.js 22 or newer. The binary includes the Node runtime, so running it does not need a Node install.

```bash
npm install
npm run compile
./dist/social-mcp
```

On Windows the file is `dist/social-mcp.exe`. The script bundles the server, generates a preparation blob, copies the Node binary, and injects the blob with `postject`. `dist/` is gitignored. Do not commit the binary.

The executable loads `.env` from the working directory the same way as `npm start`, and it speaks MCP on stdio. Logs stay on stderr.

```bash
./dist/social-mcp due
./dist/social-mcp due --watch
```

`due` runs scheduled posts once. `--watch` keeps running them (with or without the `due` argument). Claude Desktop can launch the binary directly:

```json
{
  "mcpServers": {
    "social-mcp": {
      "command": "/ABSOLUTE/PATH/TO/social-mcp/dist/social-mcp",
      "env": {
        "SOCIAL_MCP_DATA_DIR": "/ABSOLUTE/PATH/TO/social-mcp/data"
      }
    }
  }
}
```

## Environment variables

Copy `.env.example` to `.env` and set only the platforms you use. Blank values are ignored.

| Variable | Purpose |
| --- | --- |
| `SOCIAL_MCP_DATA_DIR` | Store directory. Default `./data`. |
| `SOCIAL_MCP_POLL_MS` | Watch interval for `npm run due -- --watch`. |
| `YOUTUBE_ACCESS_TOKEN` | OAuth access token for YouTube Data API v3 (`youtube.upload`). |
| `YOUTUBE_CLIENT_ID` | Used with the secret and refresh token to mint an access token. |
| `YOUTUBE_CLIENT_SECRET` | OAuth client secret. Not stored. |
| `YOUTUBE_REFRESH_TOKEN` | OAuth refresh token. Sent only to Google's token endpoint. |
| `INSTAGRAM_ACCESS_TOKEN` | Instagram Graph API user or page token with content publishing permission. |
| `INSTAGRAM_USER_ID` | Instagram professional account id. |
| `INSTAGRAM_GRAPH_VERSION` | Optional. Default `v22.0`. |
| `INSTAGRAM_GRAPH_HOST` | Optional. `graph.facebook.com` (default) or `graph.instagram.com`. |
| `INSTAGRAM_STATUS_TIMEOUT_MS` | Optional. How long to wait until a container is `FINISHED`. Default `180000`. |
| `X_OAUTH2_ACCESS_TOKEN` | User-context OAuth 2.0 token with `tweet.write` and `media.write`. |
| `X_API_KEY` | OAuth 1.0a consumer key, used when the OAuth 2.0 token is unset. |
| `X_API_SECRET` | OAuth 1.0a consumer secret. |
| `X_ACCESS_TOKEN` | OAuth 1.0a user access token. |
| `X_ACCESS_TOKEN_SECRET` | OAuth 1.0a user token secret. |

YouTube accepts either `YOUTUBE_ACCESS_TOKEN` or the client id, client secret, and refresh token. X prefers `X_OAUTH2_ACCESS_TOKEN`. An app-only bearer token cannot post.

## Data

`data/posts.json` is the store (`version` plus a `posts` array). A local media path outside that directory is copied to `data/media/<id>.<ext>` when you post or schedule. Files that already live inside the data directory stay where they are. Instagram `https` URLs are stored as URLs. `data/` is gitignored.

## What the tools call

- **YouTube:** `POST https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`, then `PUT` the file to the returned session `Location` in chunks with `Content-Range`. A `308` response resumes from the `Range` header.
- **Instagram:** `POST /{ig-user-id}/media` to create a container. Photos use `image_url`. Public videos use `video_url`. A local Reel uses `upload_type=resumable`, then `POST https://rupload.facebook.com/ig-api-upload/{version}/{container-id}` with `Authorization: OAuth`, `offset`, and `file_size`. Optional `collaborators` on that container is a list of up to 3 Instagram usernames (feed images and Reels; Stories are not supported). The server polls `status_code` and then `POST /{ig-user-id}/media_publish` with `creation_id`. Local photos are not accepted: the Graph API fetches images from a public `https` URL.
- **X:** `POST https://api.x.com/2/media/upload` with `command=INIT`, chunked `APPEND`, and `FINALIZE`, then `GET` `command=STATUS` while processing, then `POST https://api.x.com/2/tweets` with `media.media_ids`.

YouTube privacy defaults to `private`.

## Tools

| Tool | What it does |
| --- | --- |
| `post_youtube` | Upload a local video now. |
| `post_instagram` | Publish a photo URL or Reel now. Optional `collaborators` invites up to 3 usernames. |
| `post_x` | Publish a post now. Media is optional. |
| `schedule_post` | Save `platform`, `content`, `mediaPath`, and `runAt`. Instagram `collaborators` are stored and invited when the post runs. |
| `list_scheduled_posts` | List posts still waiting. |
| `get_post` | Fetch one local record by id. |
| `cancel_scheduled_post` | Cancel a post that has not started. |
| `run_due_posts` | Publish scheduled posts whose `runAt` is due. |
| `list_published_posts` | List recent posts recorded as published. |

A successful publish returns the platform id (`platformId`) and the local record id (`id`). An Instagram post also returns `invitesSent`, the usernames included on the container `collaborators` field before publish. The Graph API allows at most 3 collaborators on a feed image or Reel. Pass usernames with or without a leading `@`.

## Claude Desktop

Build first, then add the server to `claude_desktop_config.json` (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows). Use absolute paths. Set only the variables you use.

```json
{
  "mcpServers": {
    "social-mcp": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/social-mcp/dist/index.js"],
      "env": {
        "SOCIAL_MCP_DATA_DIR": "/ABSOLUTE/PATH/TO/social-mcp/data",
        "YOUTUBE_ACCESS_TOKEN": "",
        "YOUTUBE_CLIENT_ID": "",
        "YOUTUBE_CLIENT_SECRET": "",
        "YOUTUBE_REFRESH_TOKEN": "",
        "INSTAGRAM_ACCESS_TOKEN": "",
        "INSTAGRAM_USER_ID": "",
        "X_OAUTH2_ACCESS_TOKEN": "",
        "X_API_KEY": "",
        "X_API_SECRET": "",
        "X_ACCESS_TOKEN": "",
        "X_ACCESS_TOKEN_SECRET": ""
      }
    }
  }
}
```

Restart Claude Desktop after saving the file. Stdout is the MCP stream, so the process looks idle if you run it in a terminal.
