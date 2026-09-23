import asyncio
import os
import re
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from telethon import TelegramClient

API_ID = int(os.environ["TELEGRAM_API_ID"])
API_HASH = os.environ["TELEGRAM_API_HASH"]
BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
CHANNEL_ID = int(os.environ["TELEGRAM_CHANNEL_ID"])

MAX_CONCURRENT_STREAMS = max(1, int(os.getenv("MAX_CONCURRENT_STREAMS", "4")))
CHUNK_SIZE = 512 * 1024
STREAM_ACCESS_KEY = os.getenv("STREAM_ACCESS_KEY", "").strip()

client = TelegramClient(None, API_ID, API_HASH)
channel_cache = {}
stream_slots = asyncio.Semaphore(MAX_CONCURRENT_STREAMS)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await client.start(bot_token=BOT_TOKEN)
    channel_cache[CHANNEL_ID] = await client.get_entity(CHANNEL_ID)
    yield
    await client.disconnect()


app = FastAPI(title="CineTest Telegram Gateway", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "HEAD", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=[
        "Content-Length",
        "Content-Range",
        "Accept-Ranges",
        "Content-Type",
        "X-Stream-Source",
    ],
)


def parse_range(value: str | None, total: int):
    if not value:
        return 0, total - 1, False

    match = re.match(r"bytes=(\d*)-(\d*)$", value.strip())
    if not match:
        raise HTTPException(status_code=416, detail="Invalid Range header")

    first, last = match.groups()

    if first == "":
        suffix = int(last or "0")
        if suffix <= 0:
            raise HTTPException(status_code=416, detail="Invalid Range header")
        start = max(total - suffix, 0)
        end = total - 1
    else:
        start = int(first)
        end = int(last) if last else total - 1

    if start < 0 or start >= total or end < start:
        raise HTTPException(status_code=416, detail="Range not satisfiable")

    end = min(end, total - 1)
    return start, end, True


def authorize(request: Request):
    if not STREAM_ACCESS_KEY:
        return
    if request.query_params.get("key") != STREAM_ACCESS_KEY:
        raise HTTPException(status_code=401, detail="Unauthorized stream request")


async def get_channel(channel_id: int):
    if not client.is_connected():
        try:
            await client.connect()
        except Exception as exc:
            raise HTTPException(status_code=503, detail="Telegram reconnect failed") from exc

    if channel_id in channel_cache:
        return channel_cache[channel_id]

    try:
        entity = await client.get_entity(channel_id)
    except Exception as exc:
        raise HTTPException(status_code=404, detail="Telegram channel unavailable") from exc

    channel_cache[channel_id] = entity
    return entity


async def get_media_message(channel_id: int, message_id: int):
    entity = await get_channel(channel_id)

    try:
        message = await client.get_messages(entity, ids=message_id)
    except Exception as exc:
        raise HTTPException(status_code=502, detail="Telegram media lookup failed") from exc

    if not message or not message.media or not message.file:
        raise HTTPException(status_code=404, detail="Media message not found")

    size = int(message.file.size or 0)
    if size <= 0:
        raise HTTPException(status_code=404, detail="Media size unavailable")

    mime = message.file.mime_type or "application/octet-stream"
    name = (message.file.name or f"telegram-{message_id}").replace('"', "").replace("\n", " ")
    return message, size, mime, name

@app.get("/")
async def root():
    return {
        "ok": client.is_connected(),
        "service": "cinetest-telegram-gateway",
        "storage": "telegram",
        "range_streaming": True,
    }


@app.get("/health")
async def health():
    return {
        "ok": client.is_connected(),
        "service": "cinetest-telegram-gateway",
        "storage": "telegram",
        "range_streaming": True,
        "chunk_size_kb": CHUNK_SIZE // 1024,
        "max_concurrent_streams": MAX_CONCURRENT_STREAMS,
        "access_key_enabled": bool(STREAM_ACCESS_KEY),
    }


@app.api_route("/stream/{message_id}", methods=["GET", "HEAD"])
async def legacy_stream(message_id: int, request: Request):
    return await stream(CHANNEL_ID, message_id, request)


@app.api_route("/stream/{channel_id}/{message_id}", methods=["GET", "HEAD"])
async def stream(channel_id: int, message_id: int, request: Request):
    authorize(request)
    message, total, mime, name = await get_media_message(channel_id, message_id)
    start, end, partial = parse_range(request.headers.get("range"), total)
    length = end - start + 1

    headers = {
        "Accept-Ranges": "bytes",
        "Content-Type": mime,
        "Content-Length": str(length),
        "Content-Disposition": f'inline; filename="{name}"',
        "Cache-Control": "private, max-age=0, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Stream-Source": "telegram",
    }

    if partial:
        headers["Content-Range"] = f"bytes {start}-{end}/{total}"

    status_code = 206 if partial else 200

    if request.method == "HEAD":
        return Response(status_code=status_code, headers=headers, media_type=mime)

    async def body():
        remaining = length
        async with stream_slots:
            try:
                async for chunk in client.iter_download(
                    message.media,
                    offset=start,
                    request_size=CHUNK_SIZE,
                    chunk_size=CHUNK_SIZE,
                ):
                    if remaining <= 0 or await request.is_disconnected():
                        break

                    if len(chunk) > remaining:
                        chunk = chunk[:remaining]

                    remaining -= len(chunk)
                    yield chunk
            except asyncio.CancelledError:
                raise
            except Exception:
                return

    return StreamingResponse(
        body(),
        status_code=status_code,
        media_type=mime,
        headers=headers,
    )
