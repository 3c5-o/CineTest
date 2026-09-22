import os
import re
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from telethon import TelegramClient

API_ID = int(os.environ["TELEGRAM_API_ID"])
API_HASH = os.environ["TELEGRAM_API_HASH"]
BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
CHANNEL_ID = int(os.environ["TELEGRAM_CHANNEL_ID"])

client = TelegramClient(None, API_ID, API_HASH)
channel = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global channel
    await client.start(bot_token=BOT_TOKEN)
    channel = await client.get_entity(CHANNEL_ID)
    yield
    await client.disconnect()


app = FastAPI(title="CineTest Telegram Gateway", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "HEAD", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["Content-Length", "Content-Range", "Accept-Ranges", "Content-Type"],
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


async def get_media_message(message_id: int):
    if channel is None:
        raise HTTPException(status_code=503, detail="Telegram gateway is starting")

    message = await client.get_messages(channel, ids=message_id)
    if not message or not message.media or not message.file:
        raise HTTPException(status_code=404, detail="Media message not found")

    size = int(message.file.size or 0)
    if size <= 0:
        raise HTTPException(status_code=404, detail="Media size unavailable")

    mime = message.file.mime_type or "application/octet-stream"
    name = message.file.name or f"telegram-{message_id}"
    return message, size, mime, name


@app.get("/health")
async def health():
    return {
        "ok": client.is_connected(),
        "service": "cinetest-telegram-gateway",
        "storage": "telegram",
    }


@app.api_route("/stream/{message_id}", methods=["GET", "HEAD"])
async def stream(message_id: int, request: Request):
    message, total, mime, name = await get_media_message(message_id)
    start, end, partial = parse_range(request.headers.get("range"), total)
    length = end - start + 1

    headers = {
        "Accept-Ranges": "bytes",
        "Content-Type": mime,
        "Content-Length": str(length),
        "Content-Disposition": f'inline; filename="{name.replace(chr(34), "")}"',
        "Cache-Control": "private, max-age=0, no-store",
    }

    if partial:
        headers["Content-Range"] = f"bytes {start}-{end}/{total}"

    if request.method == "HEAD":
        return JSONResponse(
            content=None,
            status_code=206 if partial else 200,
            headers=headers,
        )

    async def body():
        sent = 0
        remaining = length

        async for chunk in client.iter_download(
            message.media,
            offset=start,
            request_size=512 * 1024,
            chunk_size=512 * 1024,
        ):
            if remaining <= 0:
                break

            if len(chunk) > remaining:
                chunk = chunk[:remaining]

            sent += len(chunk)
            remaining -= len(chunk)
            yield chunk

            if sent >= length:
                break

    return StreamingResponse(
        body(),
        status_code=206 if partial else 200,
        media_type=mime,
        headers=headers,
    )
