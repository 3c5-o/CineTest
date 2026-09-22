import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const OWNER_ID = "8407394858";
const FALLBACK_CHANNEL_ID = "-1004457227800";
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
const STREAM_GATEWAY = Deno.env.get("TELEGRAM_STREAM_GATEWAY") ?? "https://cinetest-i16265gs.b4a.run";
const STREAM_ACCESS_KEY = Deno.env.get("TELEGRAM_STREAM_ACCESS_KEY") ?? "";

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

type Admin = {
  telegram_user_id:number;
  display_name:string;
  role:string;
  permissions:Record<string,boolean>;
  is_active:boolean;
};

const roleDefaults:Record<string,Record<string,boolean>> = {
  owner: { content:true, visibility:true, requests:true, admins:true, logs:true, stats:true },
  secondary_admin: { content:true, visibility:true, requests:true, admins:true, logs:true, stats:true },
  content_manager: { content:true, visibility:true, requests:false, admins:false, logs:false, stats:true },
  requests_manager: { content:false, visibility:false, requests:true, admins:false, logs:false, stats:true },
  moderator: { content:false, visibility:false, requests:true, admins:false, logs:false, stats:true },
};

const roleLabels:Record<string,string> = {
  owner:"المالك",
  secondary_admin:"مدير ثانوي",
  content_manager:"مشرف محتوى",
  requests_manager:"مشرف طلبات",
  moderator:"مشرف",
};

function out(data:unknown,status=200){
  return new Response(JSON.stringify(data),{
    status,
    headers:{...cors,"Content-Type":"application/json; charset=utf-8"},
  });
}

async function tg(method:string,body:Record<string,unknown>){
  if(!BOT_TOKEN)throw new Error("TELEGRAM_BOT_TOKEN is missing");
  const r=await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify(body),
  });
  const data=await r.json();
  if(!r.ok||!data.ok)throw new Error(data?.description||"Telegram API error");
  return data.result;
}

async function send(chatId:string|number,text:string,reply_markup?:unknown){
  return tg("sendMessage",{chat_id:chatId,text,...(reply_markup?{reply_markup}:{})});
}

async function getAdmin(userId:string|number):Promise<Admin|null>{
  const n=Number(userId);
  const {data,error}=await db.from("admin_users")
    .select("telegram_user_id,display_name,role,permissions,is_active")
    .eq("telegram_user_id",n).maybeSingle();
  if(error)console.error("getAdmin",error);
  if(data?.is_active)return data as Admin;
  if(String(userId)===OWNER_ID){
    return {telegram_user_id:n,display_name:"Owner",role:"owner",permissions:{},is_active:true};
  }
  return null;
}

function can(admin:Admin,permission:string){
  if(admin.role==="owner")return true;
  const custom=admin.permissions?.[permission];
  if(typeof custom==="boolean")return custom;
  return Boolean(roleDefaults[admin.role]?.[permission]);
}

function menuFor(admin:Admin){
  const rows:any[]=[];
  if(can(admin,"content")){
    rows.push([
      {text:"إضافة فيلم",callback_data:"add_movie"},
      {text:"إضافة مسلسل",callback_data:"add_series"},
    ]);
    rows.push([{text:"إضافة حلقة",callback_data:"add_episode"}]);
  }
  rows.push([
    {text:"عرض المحتوى",callback_data:"content"},
    {text:"بحث بالـ ID",callback_data:"find_content"},
  ]);
  if(can(admin,"visibility"))rows.push([{text:"إخفاء / إظهار محتوى",callback_data:"toggle_content"}]);
  if(can(admin,"requests"))rows.push([{text:"طلبات المستخدمين",callback_data:"requests"}]);
  rows.push([{text:"الإحصائيات",callback_data:"stats"}]);
  if(can(admin,"admins"))rows.push([{text:"إدارة المشرفين",callback_data:"admins"}]);
  if(can(admin,"logs"))rows.push([{text:"سجل العمليات",callback_data:"logs"}]);
  rows.push([{text:"إلغاء",callback_data:"cancel"}]);
  return {inline_keyboard:rows};
}

async function showMenu(chatId:string|number,admin:Admin,text="لوحة إدارة CineTest"){
  const role=roleLabels[admin.role]||admin.role;
  return send(chatId,`${text}\n\nالدور: ${role} • الحد الحالي للفيديو: 500MB`,menuFor(admin));
}

async function getSession(userId:string|number){
  const {data}=await db.from("bot_sessions").select("flow,step,draft")
    .eq("telegram_user_id",Number(userId)).maybeSingle();
  return data??null;
}

async function setSession(userId:string|number,flow:string,step:string,draft:Record<string,unknown>={}){
  const {error}=await db.from("bot_sessions").upsert({
    telegram_user_id:Number(userId),flow,step,draft,updated_at:new Date().toISOString(),
  });
  if(error)throw error;
}

async function clearSession(userId:string|number){
  await db.from("bot_sessions").delete().eq("telegram_user_id",Number(userId));
}

async function logAction(adminId:string|number,action:string,entity_type?:string,entity_id?:string,content_code?:string,details:Record<string,unknown>={}){
  const {error}=await db.from("admin_logs").insert({
    admin_telegram_id:Number(adminId),action,
    entity_type:entity_type||null,entity_id:entity_id||null,content_code:content_code||null,details,
  });
  if(error)console.error("admin log",error);
}

function yearOf(s:string){
  const n=Number(s.trim());
  return Number.isInteger(n)&&n>=1888&&n<=2100?n:null;
}
function positive(s:string){
  const n=Number(s.trim());
  return Number.isInteger(n)&&n>0?n:null;
}
function getPhoto(m:any){
  const a=Array.isArray(m.photo)?m.photo:[];
  if(a.length){
    const p=a[a.length-1];
    return {file_id:p.file_id,file_unique_id:p.file_unique_id??null,mime_type:"image/jpeg",file_name:null,file_size:p.file_size??null};
  }
  const d=m.document;
  if(d?.file_id&&String(d.mime_type||"").startsWith("image/")){
    return {file_id:d.file_id,file_unique_id:d.file_unique_id??null,mime_type:d.mime_type,file_name:d.file_name??null,file_size:d.file_size??null};
  }
  return null;
}
function getVideo(m:any){
  const v=m.video;
  if(v?.file_id)return {file_id:v.file_id,file_unique_id:v.file_unique_id??null,mime_type:v.mime_type??"video/mp4",file_name:v.file_name??null,file_size:v.file_size??null};
  const d=m.document;
  if(d?.file_id&&String(d.mime_type||"").startsWith("video/")){
    return {file_id:d.file_id,file_unique_id:d.file_unique_id??null,mime_type:d.mime_type,file_name:d.file_name??null,file_size:d.file_size??null};
  }
  return null;
}
function bytesLabel(n:any){
  const v=Number(n||0);
  if(!v)return "غير معروف";
  return v>=1024**3?`${(v/1024**3).toFixed(2)}GB`:`${(v/1024**2).toFixed(1)}MB`;
}

async function configuredChannel(key:string,fallback=true){
  const {data}=await db.from("telegram_channels").select("telegram_channel_id,is_active")
    .eq("channel_key",key).maybeSingle();
  if(data?.is_active&&data.telegram_channel_id)return String(data.telegram_channel_id);
  return fallback?FALLBACK_CHANNEL_ID:null;
}

async function copyStorage(channelKey:string,fromChatId:string|number,messageId:number,caption:string,fallback=true){
  const target=await configuredChannel(channelKey,fallback);
  if(!target)return null;
  const r=await tg("copyMessage",{chat_id:target,from_chat_id:fromChatId,message_id:messageId,caption});
  return r?.message_id??null;
}

async function saveMedia(entity_type:string,entity_id:string,kind:string,file:any,channel_message_id:number|null){
  const {error}=await db.from("media_assets").upsert({
    entity_type,entity_id,kind,
    telegram_file_id:file.file_id,
    telegram_unique_id:file.file_unique_id,
    mime_type:file.mime_type,
    file_name:file.file_name,
    file_size:file.file_size,
    channel_message_id,
  },{onConflict:"entity_type,entity_id,kind"});
  if(error)throw error;
}

async function findContent(code:string){
  const c=code.trim().toUpperCase();
  for(const table of ["movies","series","episodes"]){
    const select=table==="episodes"
      ?"id,content_code,title,is_published,episode_number"
      :"id,content_code,title,is_published,release_year,genre";
    const {data}=await db.from(table).select(select).eq("content_code",c).maybeSingle();
    if(data)return {table,type:table==="movies"?"movie":table==="series"?"series":"episode",data};
  }
  return null;
}

async function contentList(chatId:string|number,admin:Admin){
  const [{data:m},{data:s},{data:e}]=await Promise.all([
    db.from("movies").select("content_code,title,release_year,is_published").order("created_at",{ascending:false}).limit(8),
    db.from("series").select("content_code,title,release_year,is_published").order("created_at",{ascending:false}).limit(8),
    db.from("episodes").select("content_code,title,episode_number,is_published").order("created_at",{ascending:false}).limit(8),
  ]);
  const ml=(m??[]).map((x:any)=>`• ${x.content_code} | ${x.title} ${x.is_published?"✅":"⛔"}`).join("\n")||"لا توجد أفلام";
  const sl=(s??[]).map((x:any)=>`• ${x.content_code} | ${x.title} ${x.is_published?"✅":"⛔"}`).join("\n")||"لا توجد مسلسلات";
  const el=(e??[]).map((x:any)=>`• ${x.content_code} | ${x.title} ${x.is_published?"✅":"⛔"}`).join("\n")||"لا توجد حلقات";
  return showMenu(chatId,admin,`آخر المحتوى:\n\nالأفلام:\n${ml}\n\nالمسلسلات:\n${sl}\n\nالحلقات:\n${el}`);
}

async function requestMenu(chatId:string|number){
  const {data}=await db.from("content_requests")
    .select("id,request_code,request_type,title,status,created_at")
    .order("created_at",{ascending:false}).limit(10);
  if(!data?.length)return send(chatId,"لا توجد طلبات مستخدمين حاليًا.",{inline_keyboard:[[{text:"رجوع",callback_data:"back"}]]});
  const rows=data.map((x:any)=>[{
    text:`${x.request_code} • ${x.request_type==="movie"?"فيلم":"مسلسل"} • ${String(x.title).slice(0,24)}`,
    callback_data:`req:${x.id}`,
  }]);
  rows.push([{text:"رجوع",callback_data:"back"}]);
  return send(chatId,"آخر طلبات المستخدمين:",{inline_keyboard:rows});
}

async function requestDetails(chatId:string|number,id:string){
  const {data}=await db.from("content_requests")
    .select("id,request_code,request_type,title,note,status,created_at")
    .eq("id",id).maybeSingle();
  if(!data)return send(chatId,"الطلب غير موجود.");
  const keyboard={inline_keyboard:[
    [{text:"قيد المراجعة",callback_data:`reqs:${id}:reviewing`},{text:"تمت الإضافة",callback_data:`reqs:${id}:added`}],
    [{text:"مرفوض",callback_data:`reqs:${id}:rejected`},{text:"مكرر",callback_data:`reqs:${id}:duplicate`}],
    [{text:"رجوع للطلبات",callback_data:"requests"}],
  ]};
  return send(chatId,`${data.request_code}\nالنوع: ${data.request_type==="movie"?"فيلم":"مسلسل"}\nالاسم: ${data.title}\nالحالة: ${data.status}\nملاحظة: ${data.note||"—"}`,keyboard);
}

async function stats(chatId:string|number,admin:Admin){
  const [mc,sc,ec,rc,sz]=await Promise.all([
    db.from("movies").select("id",{count:"exact",head:true}),
    db.from("series").select("id",{count:"exact",head:true}),
    db.from("episodes").select("id",{count:"exact",head:true}),
    db.from("content_requests").select("id",{count:"exact",head:true}).eq("status","new"),
    db.from("media_assets").select("file_size"),
  ]);
  const total=(sz.data??[]).reduce((a:number,x:any)=>a+Number(x.file_size||0),0);
  return showMenu(chatId,admin,`إحصائيات CineTest\n\nالأفلام: ${mc.count??0}\nالمسلسلات: ${sc.count??0}\nالحلقات: ${ec.count??0}\nطلبات جديدة: ${rc.count??0}\nحجم الوسائط المسجل: ${bytesLabel(total)}`);
}

async function callback(q:any){
  const userId=String(q.from?.id??"");
  const admin=await getAdmin(userId);
  if(!admin){
    await tg("answerCallbackQuery",{callback_query_id:q.id,text:"غير مصرح"});
    return;
  }
  await tg("answerCallbackQuery",{callback_query_id:q.id});
  const chatId=q.message?.chat?.id??q.from.id;
  const action=String(q.data||"");

  if(action==="cancel"||action==="back"){
    await clearSession(userId);
    return showMenu(chatId,admin,action==="cancel"?"تم الإلغاء.":"لوحة إدارة CineTest");
  }
  if(action==="add_movie"){
    if(!can(admin,"content"))return send(chatId,"لا تملك صلاحية إضافة المحتوى.");
    await setSession(userId,"movie","title",{});return send(chatId,"أرسل اسم الفيلم.");
  }
  if(action==="add_series"){
    if(!can(admin,"content"))return send(chatId,"لا تملك صلاحية إضافة المحتوى.");
    await setSession(userId,"series","title",{});return send(chatId,"أرسل اسم المسلسل.");
  }
  if(action==="add_episode"){
    if(!can(admin,"content"))return send(chatId,"لا تملك صلاحية إضافة المحتوى.");
    await setSession(userId,"episode","series_title",{});return send(chatId,"أرسل اسم المسلسل بالضبط.");
  }
  if(action==="content")return contentList(chatId,admin);
  if(action==="find_content"){
    await setSession(userId,"content_search","code",{});return send(chatId,"أرسل ID المحتوى، مثال MOV-000001 أو SER-000001-S01-E01.");
  }
  if(action==="toggle_content"){
    if(!can(admin,"visibility"))return send(chatId,"لا تملك صلاحية إخفاء المحتوى.");
    await setSession(userId,"content_toggle","code",{});return send(chatId,"أرسل ID المحتوى الذي تريد إخفاءه أو إظهاره.");
  }
  if(action==="requests"){
    if(!can(admin,"requests"))return send(chatId,"لا تملك صلاحية الطلبات.");
    return requestMenu(chatId);
  }
  if(action.startsWith("req:")){
    if(!can(admin,"requests"))return send(chatId,"لا تملك صلاحية الطلبات.");
    return requestDetails(chatId,action.slice(4));
  }
  if(action.startsWith("reqs:")){
    if(!can(admin,"requests"))return send(chatId,"لا تملك صلاحية الطلبات.");
    const [,id,status]=action.split(":");
    if(!["reviewing","added","rejected","duplicate"].includes(status))return;
    const {data,error}=await db.from("content_requests").update({status,handled_by:Number(userId)}).eq("id",id).select("request_code").single();
    if(error)throw error;
    await logAction(userId,"request_status","request",id,data?.request_code,{status});
    return requestDetails(chatId,id);
  }
  if(action==="stats")return stats(chatId,admin);
  if(action==="logs"){
    if(!can(admin,"logs"))return send(chatId,"لا تملك صلاحية السجل.");
    const {data}=await db.from("admin_logs").select("admin_telegram_id,action,content_code,created_at").order("created_at",{ascending:false}).limit(12);
    const lines=(data??[]).map((x:any)=>`• ${x.action} | ${x.content_code||"—"} | ${x.admin_telegram_id}`).join("\n")||"السجل فارغ";
    return send(chatId,`آخر العمليات:\n\n${lines}`,{inline_keyboard:[[{text:"رجوع",callback_data:"back"}]]});
  }
  if(action==="admins"){
    if(!can(admin,"admins"))return send(chatId,"لا تملك صلاحية إدارة المشرفين.");
    return send(chatId,"إدارة المشرفين",{inline_keyboard:[
      [{text:"إضافة مشرف",callback_data:"admin_add"},{text:"تعطيل مشرف",callback_data:"admin_remove"}],
      [{text:"عرض المشرفين",callback_data:"admin_list"}],
      [{text:"رجوع",callback_data:"back"}],
    ]});
  }
  if(action==="admin_add"){
    if(!can(admin,"admins"))return;
    await setSession(userId,"admin_add","telegram_id",{});return send(chatId,"أرسل Telegram ID للمشرف الجديد.");
  }
  if(action==="admin_remove"){
    if(!can(admin,"admins"))return;
    await setSession(userId,"admin_remove","telegram_id",{});return send(chatId,"أرسل Telegram ID للمشرف الذي تريد تعطيله.");
  }
  if(action==="admin_list"){
    if(!can(admin,"admins"))return;
    const {data}=await db.from("admin_users").select("telegram_user_id,display_name,role,is_active").order("created_at",{ascending:true});
    const lines=(data??[]).map((x:any)=>`• ${x.telegram_user_id} | ${roleLabels[x.role]||x.role} | ${x.is_active?"فعال":"معطل"}`).join("\n")||"لا يوجد مشرفون";
    return send(chatId,`المشرفون:\n\n${lines}`,{inline_keyboard:[[{text:"رجوع",callback_data:"admins"}]]});
  }
  if(action.startsWith("role:")){
    if(!can(admin,"admins"))return;
    const role=action.slice(5);
    if(!["secondary_admin","content_manager","requests_manager","moderator"].includes(role))return;
    const s=await getSession(userId);
    if(!s||s.flow!=="admin_add"||s.step!=="role")return send(chatId,"انتهت جلسة إضافة المشرف.");
    const target=Number(s.draft?.target_id);
    if(!target)return send(chatId,"ID غير صالح.");
    const {error}=await db.from("admin_users").upsert({
      telegram_user_id:target,display_name:"",role,permissions:{},is_active:true,added_by:Number(userId),
    });
    if(error)throw error;
    await logAction(userId,"admin_add","admin",undefined,undefined,{target,role});
    await clearSession(userId);
    return showMenu(chatId,admin,`تمت إضافة المشرف ${target} كـ ${roleLabels[role]}.`);
  }
  return showMenu(chatId,admin);
}

async function message(m:any){
  const chatId=m.chat?.id;
  if(!chatId)return;
  const userId=String(m.from?.id??"");
  const admin=await getAdmin(userId);
  if(!admin)return send(chatId,"هذا البوت مخصص لإدارة CineTest.");
  const text=String(m.text??"").trim();

  if(text==="/start"||text==="/menu"){
    await clearSession(userId);return showMenu(chatId,admin);
  }

  const s=await getSession(userId);
  if(!s)return showMenu(chatId,admin);
  const d:any={...(s.draft??{})};

  if(s.flow==="content_search"&&s.step==="code"){
    if(!text)return send(chatId,"أرسل ID كنص.");
    const found=await findContent(text);
    await clearSession(userId);
    if(!found)return showMenu(chatId,admin,"لم أجد محتوى بهذا الـID.");
    const x:any=found.data;
    return showMenu(chatId,admin,`النتيجة:\nID: ${x.content_code}\nالاسم: ${x.title}\nالنوع: ${found.type}\nالحالة: ${x.is_published?"منشور":"مخفي"}`);
  }

  if(s.flow==="content_toggle"&&s.step==="code"){
    if(!can(admin,"visibility"))return showMenu(chatId,admin,"لا تملك الصلاحية.");
    const found=await findContent(text);
    if(!found)return send(chatId,"لم أجد هذا الـID. حاول مرة أخرى أو اضغط /menu.");
    const next=!Boolean((found.data as any).is_published);
    const {error}=await db.from(found.table).update({is_published:next}).eq("id",(found.data as any).id);
    if(error)throw error;
    await logAction(userId,next?"content_publish":"content_hide",found.type,(found.data as any).id,(found.data as any).content_code,{title:(found.data as any).title});
    await clearSession(userId);
    return showMenu(chatId,admin,`${(found.data as any).content_code} أصبح ${next?"منشورًا":"مخفيًا"}.`);
  }

  if(s.flow==="admin_add"&&s.step==="telegram_id"){
    if(!/^\d{5,20}$/.test(text))return send(chatId,"Telegram ID غير صحيح.");
    d.target_id=Number(text);await setSession(userId,"admin_add","role",d);
    return send(chatId,"اختر صلاحية المشرف:",{inline_keyboard:[
      [{text:"مدير ثانوي",callback_data:"role:secondary_admin"}],
      [{text:"مشرف محتوى",callback_data:"role:content_manager"},{text:"مشرف طلبات",callback_data:"role:requests_manager"}],
      [{text:"مشرف",callback_data:"role:moderator"}],
      [{text:"إلغاء",callback_data:"cancel"}],
    ]});
  }

  if(s.flow==="admin_remove"&&s.step==="telegram_id"){
    if(!/^\d{5,20}$/.test(text))return send(chatId,"Telegram ID غير صحيح.");
    if(text===OWNER_ID)return send(chatId,"لا يمكن تعطيل حساب المالك.");
    const {data,error}=await db.from("admin_users").update({is_active:false}).eq("telegram_user_id",Number(text)).select("telegram_user_id").maybeSingle();
    if(error)throw error;
    await clearSession(userId);
    if(!data)return showMenu(chatId,admin,"لم أجد هذا المشرف.");
    await logAction(userId,"admin_disable","admin",undefined,undefined,{target:Number(text)});
    return showMenu(chatId,admin,`تم تعطيل المشرف ${text}.`);
  }

  if(s.flow==="movie"){
    if(!can(admin,"content"))return showMenu(chatId,admin,"لا تملك صلاحية إضافة المحتوى.");
    if(s.step==="title"){
      if(!text)return send(chatId,"أرسل الاسم كنص.");
      d.title=text;await setSession(userId,"movie","description",d);return send(chatId,"أرسل الوصف، أو - للتخطي.");
    }
    if(s.step==="description"){
      if(!text)return send(chatId,"أرسل الوصف.");
      d.description=text==="-"?"":text;await setSession(userId,"movie","year",d);return send(chatId,"أرسل سنة الإصدار.");
    }
    if(s.step==="year"){
      const y=yearOf(text);if(!y)return send(chatId,"السنة غير صحيحة.");
      d.release_year=y;await setSession(userId,"movie","genre",d);return send(chatId,"أرسل التصنيف.");
    }
    if(s.step==="genre"){
      if(!text)return send(chatId,"أرسل التصنيف.");
      d.genre=text;await setSession(userId,"movie","poster",d);return send(chatId,"أرسل بوستر الفيلم.");
    }
    if(s.step==="poster"){
      const f=getPhoto(m);if(!f)return send(chatId,"أرسل صورة.");
      d.poster={...f,source_message_id:m.message_id};
      await setSession(userId,"movie","video",d);
      return send(chatId,"أرسل فيديو الفيلم. الحد الحالي 500MB.");
    }
    if(s.step==="video"){
      const f=getVideo(m);if(!f)return send(chatId,"أرسل فيديو.");
      if(f.file_size&&f.file_size>MAX_VIDEO_BYTES)return send(chatId,`حجم الفيديو ${bytesLabel(f.file_size)} ويتجاوز حد 500MB.`);
      const {data:movie,error}=await db.from("movies").insert({
        title:d.title,description:d.description??"",release_year:d.release_year,genre:d.genre??"",is_published:false,
      }).select("id,content_code").single();
      if(error||!movie)throw error??new Error("movie insert failed");
      const posterCaption=`${movie.content_code}\n🎬 ${d.title}\nالسنة: ${d.release_year}\nالتصنيف: ${d.genre}\nالنوع: فيلم`;
      const pm=await copyStorage("movies_info",chatId,d.poster.source_message_id,posterCaption,true);
      const vm=await copyStorage("movies_storage",chatId,m.message_id,`${movie.content_code} | VIDEO | ${d.title}`,true);
      await saveMedia("movie",movie.id,"poster",d.poster,pm);
      await saveMedia("movie",movie.id,"video",f,vm);
      await db.from("movies").update({is_published:true}).eq("id",movie.id);
      await logAction(userId,"movie_add","movie",movie.id,movie.content_code,{title:d.title,file_size:f.file_size??null});
      await clearSession(userId);
      return showMenu(chatId,admin,`تمت إضافة الفيلم بنجاح.\nID: ${movie.content_code}\nالحجم: ${bytesLabel(f.file_size)}`);
    }
  }

  if(s.flow==="series"){
    if(!can(admin,"content"))return showMenu(chatId,admin,"لا تملك صلاحية إضافة المحتوى.");
    if(s.step==="title"){if(!text)return send(chatId,"أرسل الاسم.");d.title=text;await setSession(userId,"series","description",d);return send(chatId,"أرسل الوصف، أو - للتخطي.");}
    if(s.step==="description"){if(!text)return send(chatId,"أرسل الوصف.");d.description=text==="-"?"":text;await setSession(userId,"series","year",d);return send(chatId,"أرسل سنة الإصدار.");}
    if(s.step==="year"){const y=yearOf(text);if(!y)return send(chatId,"السنة غير صحيحة.");d.release_year=y;await setSession(userId,"series","genre",d);return send(chatId,"أرسل التصنيف.");}
    if(s.step==="genre"){if(!text)return send(chatId,"أرسل التصنيف.");d.genre=text;await setSession(userId,"series","poster",d);return send(chatId,"أرسل بوستر المسلسل.");}
    if(s.step==="poster"){
      const f=getPhoto(m);if(!f)return send(chatId,"أرسل صورة.");
      const {data:ser,error}=await db.from("series").insert({
        title:d.title,description:d.description??"",release_year:d.release_year,genre:d.genre??"",is_published:false,
      }).select("id,content_code").single();
      if(error||!ser)throw error??new Error("series insert failed");
      const cap=`${ser.content_code}\n📺 ${d.title}\nالسنة: ${d.release_year}\nالتصنيف: ${d.genre}\nالنوع: مسلسل`;
      const cm=await copyStorage("series_info",chatId,m.message_id,cap,true);
      await saveMedia("series",ser.id,"poster",f,cm);
      await db.from("series").update({is_published:true}).eq("id",ser.id);
      await logAction(userId,"series_add","series",ser.id,ser.content_code,{title:d.title});
      await clearSession(userId);
      return showMenu(chatId,admin,`تمت إضافة المسلسل.\nID: ${ser.content_code}\nيمكنك الآن إضافة الحلقات.`);
    }
  }

  if(s.flow==="episode"){
    if(!can(admin,"content"))return showMenu(chatId,admin,"لا تملك صلاحية إضافة المحتوى.");
    if(s.step==="series_title"){
      if(!text)return send(chatId,"أرسل اسم المسلسل.");
      const {data,error}=await db.from("series").select("id,title,content_code").ilike("title",text).limit(1);
      if(error)throw error;
      if(!data?.length)return send(chatId,"لم أجد المسلسل.");
      d.series_id=data[0].id;d.series_title=data[0].title;d.series_code=data[0].content_code;
      await setSession(userId,"episode","season_number",d);return send(chatId,"أرسل رقم الموسم.");
    }
    if(s.step==="season_number"){const n=positive(text);if(!n)return send(chatId,"رقم الموسم غير صحيح.");d.season_number=n;await setSession(userId,"episode","episode_number",d);return send(chatId,"أرسل رقم الحلقة.");}
    if(s.step==="episode_number"){const n=positive(text);if(!n)return send(chatId,"رقم الحلقة غير صحيح.");d.episode_number=n;await setSession(userId,"episode","episode_title",d);return send(chatId,"أرسل عنوان الحلقة، أو - للاسم التلقائي.");}
    if(s.step==="episode_title"){if(!text)return send(chatId,"أرسل العنوان.");d.episode_title=text==="-"?`الحلقة ${d.episode_number}`:text;await setSession(userId,"episode","video",d);return send(chatId,"أرسل فيديو الحلقة. الحد الحالي 500MB.");}
    if(s.step==="video"){
      const f=getVideo(m);if(!f)return send(chatId,"أرسل فيديو.");
      if(f.file_size&&f.file_size>MAX_VIDEO_BYTES)return send(chatId,`حجم الفيديو ${bytesLabel(f.file_size)} ويتجاوز حد 500MB.`);
      const {data:season,error:se}=await db.from("seasons").upsert({
        series_id:d.series_id,season_number:d.season_number,title:`الموسم ${d.season_number}`,
      },{onConflict:"series_id,season_number"}).select("id").single();
      if(se||!season)throw se??new Error("season failed");
      const {data:ep,error:ee}=await db.from("episodes").upsert({
        season_id:season.id,episode_number:d.episode_number,title:d.episode_title,description:"",is_published:false,
      },{onConflict:"season_id,episode_number"}).select("id,content_code").single();
      if(ee||!ep)throw ee??new Error("episode failed");
      const cm=await copyStorage("series_storage",chatId,m.message_id,`${ep.content_code} | ${d.series_title} | موسم ${d.season_number} | حلقة ${d.episode_number}`,true);
      await saveMedia("episode",ep.id,"video",f,cm);
      await db.from("episodes").update({is_published:true}).eq("id",ep.id);
      await logAction(userId,"episode_add","episode",ep.id,ep.content_code,{series:d.series_title,file_size:f.file_size??null});
      await clearSession(userId);
      return showMenu(chatId,admin,`تمت إضافة الحلقة.\nID: ${ep.content_code}\nالحجم: ${bytesLabel(f.file_size)}`);
    }
  }

  return showMenu(chatId,admin);
}

async function asset(type:string,id:string){
  if(!/^[0-9a-fA-F-]{36}$/.test(id))return null;
  let entity_type="",kind="";
  if(type==="movie_poster"||type==="movie_video"){
    const {data}=await db.from("movies").select("is_published").eq("id",id).maybeSingle();
    if(!data?.is_published)return null;
    entity_type="movie";kind=type==="movie_poster"?"poster":"video";
  }else if(type==="series_poster"){
    const {data}=await db.from("series").select("is_published").eq("id",id).maybeSingle();
    if(!data?.is_published)return null;
    entity_type="series";kind="poster";
  }else if(type==="episode_video"){
    const {data:e}=await db.from("episodes").select("season_id,is_published").eq("id",id).maybeSingle();
    if(!e?.is_published)return null;
    const {data:se}=await db.from("seasons").select("series_id").eq("id",e.season_id).maybeSingle();
    if(!se)return null;
    const {data:sr}=await db.from("series").select("is_published").eq("id",se.series_id).maybeSingle();
    if(!sr?.is_published)return null;
    entity_type="episode";kind="video";
  }else return null;
  const {data}=await db.from("media_assets")
    .select("telegram_file_id,mime_type,file_size,channel_message_id")
    .eq("entity_type",entity_type).eq("entity_id",id).eq("kind",kind).maybeSingle();
  return data??null;
}

async function media(type:string,id:string){
  const a:any=await asset(type,id);
  if(!a)return out({error:"not found"},404);
  const isVideo=type==="movie_video"||type==="episode_video";
  if(isVideo){
    if(a.file_size&&Number(a.file_size)>MAX_VIDEO_BYTES)return out({error:"current limit is 500MB"},413);
    if(!a.channel_message_id)return out({error:"Telegram channel message id is missing"},409);
    const auth=STREAM_ACCESS_KEY?`?key=${encodeURIComponent(STREAM_ACCESS_KEY)}`:"";
    return Response.redirect(`${STREAM_GATEWAY}/stream/${a.channel_message_id}${auth}`,307);
  }
  let f:any;
  try{f=await tg("getFile",{file_id:a.telegram_file_id});}
  catch{return out({error:"Telegram getFile failed"},502);}
  const up=await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${f.file_path}`);
  const oh=new Headers(cors);
  oh.set("Content-Type",up.headers.get("content-type")||a.mime_type||"application/octet-stream");
  oh.set("Content-Disposition","inline");
  oh.set("Cache-Control","public, max-age=3600");
  const len=up.headers.get("content-length");if(len)oh.set("content-length",len);
  return new Response(up.body,{status:up.status,headers:oh});
}

async function publicRequest(req:Request){
  const body=await req.json().catch(()=>null);
  if(!body)return out({error:"invalid body"},400);
  const type=String(body.request_type||"");
  const title=String(body.title||"").trim().slice(0,160);
  const note=String(body.note||"").trim().slice(0,500);
  const requester=String(body.requester_key||"").trim();
  if(!["movie","series"].includes(type))return out({error:"invalid request type"},400);
  if(title.length<2)return out({error:"title is too short"},400);
  if(!/^[A-Za-z0-9_-]{20,100}$/.test(requester))return out({error:"invalid requester key"},400);

  const since=new Date(Date.now()-24*60*60*1000).toISOString();
  const {count}=await db.from("content_requests").select("id",{count:"exact",head:true})
    .eq("requester_key",requester).gte("created_at",since);
  if((count??0)>=5)return out({error:"daily request limit reached"},429);

  const {data:dup}=await db.from("content_requests")
    .select("request_code,status,title").eq("requester_key",requester)
    .ilike("title",title).in("status",["new","reviewing","added"]).limit(1);
  if(dup?.length)return out({ok:true,duplicate:true,request:dup[0]});

  const {data,error}=await db.from("content_requests").insert({
    request_type:type,title,note,requester_key:requester,status:"new",
  }).select("id,request_code,request_type,title,status,created_at").single();
  if(error)throw error;

  const requestChannel=await configuredChannel("requests",false);
  if(requestChannel){
    await tg("sendMessage",{chat_id:requestChannel,text:`طلب جديد\n${data.request_code}\nالنوع: ${type==="movie"?"فيلم":"مسلسل"}\nالاسم: ${title}\nملاحظة: ${note||"—"}`}).catch(console.error);
  }
  return out({ok:true,request:data},201);
}

async function publicRequestStatus(url:URL){
  const requester=String(url.searchParams.get("requester_key")||"");
  if(!/^[A-Za-z0-9_-]{20,100}$/.test(requester))return out({error:"invalid requester key"},400);
  const {data,error}=await db.from("content_requests")
    .select("request_code,request_type,title,status,created_at,updated_at")
    .eq("requester_key",requester).order("created_at",{ascending:false}).limit(20);
  if(error)throw error;
  return out({ok:true,requests:data??[]});
}

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  try{
    const url=new URL(req.url);
    const action=url.searchParams.get("action");

    if(req.method==="GET"&&url.searchParams.get("health")==="1"){
      return out({
        ok:true,botConfigured:Boolean(BOT_TOKEN),secretConfigured:Boolean(BOT_SECRET),
        streamGateway:STREAM_GATEWAY,maxVideoMB:500,
        features:["content_ids","admin_roles","user_requests","soft_visibility","admin_logs"],
      });
    }

    if(req.method==="POST"&&action==="request_content")return publicRequest(req);
    if(req.method==="GET"&&action==="request_status")return publicRequestStatus(url);

    if(req.method==="GET"&&url.searchParams.has("setup")){
      if(!BOT_SECRET||url.searchParams.get("setup")!==BOT_SECRET)return out({error:"unauthorized"},401);
      if(!BOT_TOKEN)return out({error:"bot token missing"},503);
      const webhook=`${SUPABASE_URL}/functions/v1/telegram-gateway`;
      const r=await tg("setWebhook",{url:webhook,secret_token:BOT_SECRET,allowed_updates:["message","callback_query"],drop_pending_updates:true});
      return out({ok:true,webhook,telegram:r});
    }

    const mt=url.searchParams.get("media"),id=url.searchParams.get("id");
    if(req.method==="GET"&&mt&&id)return media(mt,id);

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
