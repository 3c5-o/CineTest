import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const ADMIN_ID = "8407394858";
const CHANNEL_ID = "-1004457227800";
const MAX_TEST_FILE = 20 * 1024 * 1024;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const keyMapRaw = Deno.env.get("SUPABASE_SECRET_KEYS");
const secretKey = keyMapRaw
  ? (JSON.parse(keyMapRaw)["default"] ?? "")
  : (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

const db = createClient(SUPABASE_URL, secretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const BOT_SECRET = Deno.env.get("TELEGRAM_BOT_SECRET") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, range",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
};

function out(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
  });
}

async function tg(method: string, body: Record<string, unknown>) {
  if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is missing");
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok || !data.ok) throw new Error(data?.description || "Telegram API error");
  return data.result;
}

const menu = {
  inline_keyboard: [
    [
      { text: "إضافة فيلم", callback_data: "add_movie" },
      { text: "إضافة مسلسل", callback_data: "add_series" },
    ],
    [
      { text: "إضافة حلقة", callback_data: "add_episode" },
      { text: "عرض المحتوى", callback_data: "content" },
    ],
    [{ text: "إلغاء", callback_data: "cancel" }],
  ],
};

async function send(chatId: string | number, text: string, reply_markup?: unknown) {
  return tg("sendMessage", { chat_id: chatId, text, ...(reply_markup ? { reply_markup } : {}) });
}
async function showMenu(chatId: string | number, text = "لوحة إدارة CineTest") {
  return send(chatId, text, menu);
}
async function getSession() {
  const { data } = await db.from("bot_sessions").select("flow,step,draft")
    .eq("telegram_user_id", Number(ADMIN_ID)).maybeSingle();
  return data ?? null;
}
async function setSession(flow: string, step: string, draft: Record<string, unknown> = {}) {
  const { error } = await db.from("bot_sessions").upsert({
    telegram_user_id: Number(ADMIN_ID),
    flow, step, draft, updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}
async function clearSession() {
  await db.from("bot_sessions").delete().eq("telegram_user_id", Number(ADMIN_ID));
}
function yearOf(s: string) {
  const n = Number(s.trim());
  return Number.isInteger(n) && n >= 1888 && n <= 2100 ? n : null;
}
function positive(s: string) {
  const n = Number(s.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}
function getPhoto(m: any) {
  const a = Array.isArray(m.photo) ? m.photo : [];
  if (a.length) {
    const p = a[a.length - 1];
    return { file_id:p.file_id, file_unique_id:p.file_unique_id ?? null, mime_type:"image/jpeg", file_name:null, file_size:p.file_size ?? null };
  }
  const d = m.document;
  if (d?.file_id && String(d.mime_type || "").startsWith("image/")) {
    return { file_id:d.file_id, file_unique_id:d.file_unique_id ?? null, mime_type:d.mime_type, file_name:d.file_name ?? null, file_size:d.file_size ?? null };
  }
  return null;
}
function getVideo(m: any) {
  const v = m.video;
  if (v?.file_id) return { file_id:v.file_id, file_unique_id:v.file_unique_id ?? null, mime_type:v.mime_type ?? "video/mp4", file_name:v.file_name ?? null, file_size:v.file_size ?? null };
  const d = m.document;
  if (d?.file_id && String(d.mime_type || "").startsWith("video/")) {
    return { file_id:d.file_id, file_unique_id:d.file_unique_id ?? null, mime_type:d.mime_type, file_name:d.file_name ?? null, file_size:d.file_size ?? null };
  }
  return null;
}
async function copyStorage(fromChatId: string | number, messageId: number, caption: string) {
  const r = await tg("copyMessage", { chat_id: CHANNEL_ID, from_chat_id: fromChatId, message_id: messageId, caption });
  return r?.message_id ?? null;
}
async function saveMedia(entity_type: string, entity_id: string, kind: string, file: any, channel_message_id: number | null) {
  const { error } = await db.from("media_assets").upsert({
    entity_type, entity_id, kind,
    telegram_file_id:file.file_id,
    telegram_unique_id:file.file_unique_id,
    mime_type:file.mime_type,
    file_name:file.file_name,
    file_size:file.file_size,
    channel_message_id,
  }, { onConflict:"entity_type,entity_id,kind" });
  if (error) throw error;
}

async function callback(q: any) {
  if (String(q.from?.id ?? "") !== ADMIN_ID) {
    await tg("answerCallbackQuery", { callback_query_id:q.id, text:"غير مصرح" });
    return;
  }
  await tg("answerCallbackQuery", { callback_query_id:q.id });
  const chatId = q.message?.chat?.id ?? q.from.id;
  if (q.data === "cancel") {
    await clearSession();
    return showMenu(chatId, "تم الإلغاء.");
  }
  if (q.data === "add_movie") {
    await setSession("movie","title",{});
    return send(chatId,"أرسل اسم الفيلم.");
  }
  if (q.data === "add_series") {
    await setSession("series","title",{});
    return send(chatId,"أرسل اسم المسلسل.");
  }
  if (q.data === "add_episode") {
    await setSession("episode","series_title",{});
    return send(chatId,"أرسل اسم المسلسل بالضبط.");
  }
  if (q.data === "content") {
    const [{data:m},{data:s}] = await Promise.all([
      db.from("movies").select("title,release_year").order("created_at",{ascending:false}).limit(10),
      db.from("series").select("title,release_year").order("created_at",{ascending:false}).limit(10),
    ]);
    const ml = (m ?? []).map((x:any)=>`• ${x.title} ${x.release_year ?? ""}`).join("\n") || "لا توجد أفلام";
    const sl = (s ?? []).map((x:any)=>`• ${x.title} ${x.release_year ?? ""}`).join("\n") || "لا توجد مسلسلات";
    return showMenu(chatId,`الأفلام:\n${ml}\n\nالمسلسلات:\n${sl}`);
  }
  return showMenu(chatId);
}

async function message(m: any) {
  const chatId = m.chat?.id;
  if (!chatId) return;
  if (String(m.from?.id ?? "") !== ADMIN_ID) return send(chatId,"هذا البوت مخصص للإدارة.");
  const text = String(m.text ?? "").trim();

  if (text === "/start" || text === "/menu") {
    await clearSession();
    return showMenu(chatId);
  }

  const s = await getSession();
  if (!s) return showMenu(chatId);
  const d:any = { ...(s.draft ?? {}) };

  if (s.flow === "movie") {
    if (s.step === "title") {
      if (!text) return send(chatId,"أرسل الاسم كنص.");
      d.title=text; await setSession("movie","description",d); return send(chatId,"أرسل الوصف، أو - للتخطي.");
    }
    if (s.step === "description") {
      if (!text) return send(chatId,"أرسل الوصف.");
      d.description=text==="-"?"":text; await setSession("movie","year",d); return send(chatId,"أرسل سنة الإصدار.");
    }
    if (s.step === "year") {
      const y=yearOf(text); if(!y) return send(chatId,"السنة غير صحيحة.");
      d.release_year=y; await setSession("movie","genre",d); return send(chatId,"أرسل التصنيف.");
    }
    if (s.step === "genre") {
      if(!text) return send(chatId,"أرسل التصنيف.");
      d.genre=text; await setSession("movie","poster",d); return send(chatId,"أرسل بوستر الفيلم.");
    }
    if (s.step === "poster") {
      const f=getPhoto(m); if(!f) return send(chatId,"أرسل صورة.");
      const cm=await copyStorage(chatId,m.message_id,`CineTest | فيلم: ${d.title} | بوستر`);
      d.poster={...f,channel_message_id:cm}; await setSession("movie","video",d);
      return send(chatId,"أرسل فيديو تجريبي أقل من 20MB.");
    }
    if (s.step === "video") {
      const f=getVideo(m); if(!f) return send(chatId,"أرسل فيديو.");
      if(f.file_size && f.file_size>MAX_TEST_FILE) return send(chatId,"للتجربة الأولى أرسل فيديو أقل من 20MB.");
      const cm=await copyStorage(chatId,m.message_id,`CineTest | فيلم: ${d.title} | فيديو`);
      const {data:movie,error}=await db.from("movies").insert({
        title:d.title,description:d.description ?? "",release_year:d.release_year,genre:d.genre ?? "",is_published:true
      }).select("id").single();
      if(error||!movie) throw error ?? new Error("movie insert failed");
      await saveMedia("movie",movie.id,"poster",d.poster,d.poster.channel_message_id ?? null);
      await saveMedia("movie",movie.id,"video",f,cm);
      await clearSession();
      return showMenu(chatId,`تمت إضافة الفيلم: ${d.title}`);
    }
  }

  if (s.flow === "series") {
    if (s.step === "title") { if(!text)return send(chatId,"أرسل الاسم."); d.title=text; await setSession("series","description",d); return send(chatId,"أرسل الوصف، أو - للتخطي."); }
    if (s.step === "description") { if(!text)return send(chatId,"أرسل الوصف."); d.description=text==="-"?"":text; await setSession("series","year",d); return send(chatId,"أرسل سنة الإصدار."); }
    if (s.step === "year") { const y=yearOf(text); if(!y)return send(chatId,"السنة غير صحيحة."); d.release_year=y; await setSession("series","genre",d); return send(chatId,"أرسل التصنيف."); }
    if (s.step === "genre") { if(!text)return send(chatId,"أرسل التصنيف."); d.genre=text; await setSession("series","poster",d); return send(chatId,"أرسل بوستر المسلسل."); }
    if (s.step === "poster") {
      const f=getPhoto(m); if(!f)return send(chatId,"أرسل صورة.");
      const cm=await copyStorage(chatId,m.message_id,`CineTest | مسلسل: ${d.title} | بوستر`);
      const {data:ser,error}=await db.from("series").insert({
        title:d.title,description:d.description ?? "",release_year:d.release_year,genre:d.genre ?? "",is_published:true
      }).select("id").single();
      if(error||!ser) throw error ?? new Error("series insert failed");
      await saveMedia("series",ser.id,"poster",f,cm);
      await clearSession();
      return showMenu(chatId,`تمت إضافة المسلسل: ${d.title}. الآن يمكنك إضافة حلقة.`);
    }
  }

  if (s.flow === "episode") {
    if (s.step === "series_title") {
      if(!text)return send(chatId,"أرسل اسم المسلسل.");
      const {data,error}=await db.from("series").select("id,title").ilike("title",text).limit(1);
      if(error)throw error;
      if(!data?.length)return send(chatId,"لم أجد المسلسل.");
      d.series_id=data[0].id; d.series_title=data[0].title; await setSession("episode","season_number",d); return send(chatId,"أرسل رقم الموسم.");
    }
    if (s.step === "season_number") { const n=positive(text); if(!n)return send(chatId,"رقم الموسم غير صحيح."); d.season_number=n; await setSession("episode","episode_number",d); return send(chatId,"أرسل رقم الحلقة."); }
    if (s.step === "episode_number") { const n=positive(text); if(!n)return send(chatId,"رقم الحلقة غير صحيح."); d.episode_number=n; await setSession("episode","episode_title",d); return send(chatId,"أرسل عنوان الحلقة، أو - للاسم التلقائي."); }
    if (s.step === "episode_title") { if(!text)return send(chatId,"أرسل العنوان."); d.episode_title=text==="-"?`الحلقة ${d.episode_number}`:text; await setSession("episode","video",d); return send(chatId,"أرسل فيديو الحلقة أقل من 20MB."); }
    if (s.step === "video") {
      const f=getVideo(m); if(!f)return send(chatId,"أرسل فيديو.");
      if(f.file_size && f.file_size>MAX_TEST_FILE)return send(chatId,"للتجربة أرسل فيديو أقل من 20MB.");
      const cm=await copyStorage(chatId,m.message_id,`CineTest | ${d.series_title} | موسم ${d.season_number} | حلقة ${d.episode_number}`);
      const {data:season,error:se}=await db.from("seasons").upsert({
        series_id:d.series_id,season_number:d.season_number,title:`الموسم ${d.season_number}`
      },{onConflict:"series_id,season_number"}).select("id").single();
      if(se||!season)throw se ?? new Error("season failed");
      const {data:ep,error:ee}=await db.from("episodes").upsert({
        season_id:season.id,episode_number:d.episode_number,title:d.episode_title,description:"",is_published:true
      },{onConflict:"season_id,episode_number"}).select("id").single();
      if(ee||!ep)throw ee ?? new Error("episode failed");
      await saveMedia("episode",ep.id,"video",f,cm);
      await clearSession();
      return showMenu(chatId,`تمت إضافة الحلقة ${d.episode_number} من ${d.series_title}.`);
    }
  }

  return showMenu(chatId);
}

async function asset(type:string,id:string) {
  if(!/^[0-9a-fA-F-]{36}$/.test(id))return null;
  let entity_type="",kind="";
  if(type==="movie_poster"||type==="movie_video"){
    const {data}=await db.from("movies").select("is_published").eq("id",id).maybeSingle();
    if(!data?.is_published)return null;
    entity_type="movie"; kind=type==="movie_poster"?"poster":"video";
  } else if(type==="series_poster"){
    const {data}=await db.from("series").select("is_published").eq("id",id).maybeSingle();
    if(!data?.is_published)return null;
    entity_type="series"; kind="poster";
  } else if(type==="episode_video"){
    const {data:e}=await db.from("episodes").select("season_id,is_published").eq("id",id).maybeSingle();
    if(!e?.is_published)return null;
    const {data:se}=await db.from("seasons").select("series_id").eq("id",e.season_id).maybeSingle();
    if(!se)return null;
    const {data:sr}=await db.from("series").select("is_published").eq("id",se.series_id).maybeSingle();
    if(!sr?.is_published)return null;
    entity_type="episode"; kind="video";
  } else return null;
  const {data}=await db.from("media_assets").select("telegram_file_id,mime_type,file_size")
    .eq("entity_type",entity_type).eq("entity_id",id).eq("kind",kind).maybeSingle();
  return data ?? null;
}

async function media(req:Request,type:string,id:string){
  const a:any=await asset(type,id);
  if(!a)return out({error:"not found"},404);
  if(a.file_size && Number(a.file_size)>MAX_TEST_FILE)return out({error:"test limit is 20MB"},413);
  let f:any;
  try{f=await tg("getFile",{file_id:a.telegram_file_id});}
  catch{return out({error:"Telegram getFile failed"},502);}
  const h:Record<string,string>={};
  const range=req.headers.get("range"); if(range)h.Range=range;
  const up=await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${f.file_path}`,{headers:h});
  const oh=new Headers(cors);
  oh.set("Content-Type",up.headers.get("content-type")||a.mime_type||"application/octet-stream");
  oh.set("Content-Disposition","inline");
  oh.set("Cache-Control",type.includes("poster")?"public, max-age=3600":"no-store");
  for(const k of ["content-length","content-range","accept-ranges"]){const v=up.headers.get(k);if(v)oh.set(k,v);}
  return new Response(up.body,{status:up.status,headers:oh});
}

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  try{
    const url=new URL(req.url);
    if(req.method==="GET"&&url.searchParams.get("health")==="1"){
      return out({ok:true,botConfigured:Boolean(BOT_TOKEN),secretConfigured:Boolean(BOT_SECRET)});
    }
    if(req.method==="GET"&&url.searchParams.has("setup")){
      if(!BOT_SECRET||url.searchParams.get("setup")!==BOT_SECRET)return out({error:"unauthorized"},401);
      if(!BOT_TOKEN)return out({error:"bot token missing"},503);
      const webhook=`${SUPABASE_URL}/functions/v1/telegram-gateway`;
      const r=await tg("setWebhook",{url:webhook,secret_token:BOT_SECRET,allowed_updates:["message","callback_query"],drop_pending_updates:true});
      return out({ok:true,webhook,telegram:r});
    }
    const mt=url.searchParams.get("media"), id=url.searchParams.get("id");
    if(req.method==="GET"&&mt&&id)return media(req,mt,id);
    if(req.method!=="POST")return out({error:"method not allowed"},405);
    if(!BOT_SECRET||req.headers.get("x-telegram-bot-api-secret-token")!==BOT_SECRET)return out({error:"bad webhook signature"},403);
    const u=await req.json();
    if(u.callback_query)await callback(u.callback_query);
    else if(u.message)await message(u.message);
    return out({ok:true});
  }catch(e){
    console.error(e);
    return out({error:e instanceof Error?e.message:"unknown error"},500);
  }
});