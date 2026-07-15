export function createPetLibraryApp(windowObject){
  "use strict";

  var window=windowObject;
  var document=window.document;

  var PALETTE_HEX={graphite:"#555a62",green:"#208553",blue:"#2f67d8",violet:"#7651c7",
    red:"#d84a39",amber:"#c57a1b",teal:"#0e7d85",mono:"#8a8577"};

  /* Local fallback catalog: used only when /api/pets is not reachable (the
     Pages proxy is not configured, or the gateway is unavailable). Mirrors
     gateway/lib/companion-catalog.js's BUILTIN_COMPANIONS visual data so the
     library still renders full animated previews per the spec's "local
     fallback" scenario. Apply/generate still report a gateway blocker. */
  var FALLBACK_PETS=[
    petRecord("shigmi-steward","Shigmi Steward","Default voice-first operator for everyday routing, memory, and short answers.",["default","operations","voice","routing"],"steward","graphite","hover",1),
    petRecord("shigmi-scout","Shigmi Scout","Research and discovery companion for searching, comparing, and narrowing options.",["research","discovery","search","compare"],"scout","green","peek",1),
    petRecord("shigmi-builder","Shigmi Builder","Implementation companion for code changes, tests, and deployment blockers.",["coding","build","tests","implementation"],"builder","blue","tap",1),
    petRecord("shigmi-scribe","Shigmi Scribe","Writing companion for notes, emails, specs, drafts, and concise rewrites.",["writing","docs","notes","drafting"],"scribe","violet","trail",1),
    petRecord("shigmi-sentinel","Shigmi Sentinel","Vigilant companion for monitoring alerts, incidents, and risk before they escalate.",["security","monitoring","alerts","incident-response"],"sentinel","red","tap",1.05),
    petRecord("shigmi-cartographer","Shigmi Cartographer","Planning companion for roadmaps, sequencing, and turning goals into an ordered path.",["planning","roadmap","sequencing","navigation"],"cartographer","teal","peek",0.95),
    petRecord("shigmi-tinker","Shigmi Tinker","Prototyping companion for quick experiments, small tools, and testing an idea fast.",["prototyping","tools","experiments","playful"],"tinker","amber","spark",0.9),
    petRecord("shigmi-nomad","Shigmi Nomad","Scheduling companion for logistics, travel, and keeping commitments moving.",["scheduling","logistics","travel","planning"],"nomad","mono","walk",1.2),
    petRecord("shigmi-lumen","Shigmi Lumen","Brainstorming companion for generating ideas fast and finding the sharpest one.",["brainstorming","ideas","creative","playful"],"lumen","violet","float",0.85),
    petRecord("shigmi-anchor","Shigmi Anchor","Grounding companion for focus, calm, and steady follow-through on one thing at a time.",["focus","calm","wellbeing","grounding"],"anchor","blue","hover",1.1)
  ];

  var state={
    pets:[],hero:null,query:"",tag:"",
    x:140,y:120,vx:44,vy:0,dir:1,mode:"walk",drag:false,last:0,nextModeAt:0
  };

  var els={
    stage:document.getElementById("stage"),
    heroName:document.getElementById("heroName"),
    heroMeta:document.getElementById("heroMeta"),
    heroTags:document.getElementById("heroTags"),
    previewBtn:document.getElementById("previewBtn"),
    studioBtn:document.getElementById("studioBtn"),
    applyBtn:document.getElementById("applyBtn"),
    consoleTitle:document.getElementById("consoleTitle"),
    consoleLine:document.getElementById("consoleLine"),
    searchInput:document.getElementById("searchInput"),
    tagChips:document.getElementById("tagChips"),
    catalogStatus:document.getElementById("catalogStatus"),
    grid:document.getElementById("grid")
  };

  var heroActor=null,heroCreature=null;

  bindEvents();
  var ready=loadPets();
  window.requestAnimationFrame(tick);

  function petRecord(id,name,summary,tags,skin,palette,motion,scale){
    return {
      id:id,companion_id:id,companion_name:name,companion_summary:summary,source:"builtin",
      tags:tags,voice:"",
      pet:{renderer:"shimeji-web",family:"shigmi",skin:skin,palette:palette,motion:motion,scale:scale}
    };
  }

  function normalizePet(item){
    var companion=item.companion||item;
    var pet=item.pet||companion.pet||{};
    return {
      id:item.id||item.companion_id||companion.id,
      companion_id:item.companion_id||companion.id||item.id,
      companion_name:item.companion_name||companion.name||"Custom pet",
      companion_summary:item.companion_summary||companion.summary||"",
      source:item.source||companion.source||"custom",
      tags:item.tags||companion.tags||[],
      pet:{
        skin:pet.skin||"companion",
        palette:pet.palette||"blue",
        motion:pet.motion||"walk",
        scale:Number(pet.scale)||1
      }
    };
  }

  async function loadPets(){
    try{
      var res=await window.fetch("/api/pets",{headers:{accept:"application/json"}});
      if(!res.ok)throw new Error("HTTP "+res.status);
      var data=await res.json();
      var pets=(data.pets||[]).map(normalizePet);
      state.pets=pets.length?pets:FALLBACK_PETS;
      els.catalogStatus.textContent=state.pets.length+" pets · gateway";
    }catch(err){
      state.pets=FALLBACK_PETS;
      els.catalogStatus.textContent=state.pets.length+" pets · local fallback";
    }
    renderTagChips();
    buildAmbient();
    setupHero();
    selectHero(pickFromUrl()||state.pets[0]);
    renderGrid();
  }

  function pickFromUrl(){
    var id=new URLSearchParams(window.location.search).get("companion");
    if(!id)return null;
    var match=state.pets.filter(function(item){return item.id===id;})[0];
    return match||null;
  }

  function renderTagChips(){
    var tags={};
    state.pets.forEach(function(item){(item.tags||[]).forEach(function(tag){tags[tag]=true;});});
    var list=Object.keys(tags).slice(0,10);
    els.tagChips.innerHTML="";
    list.forEach(function(tag){
      var button=document.createElement("button");
      button.type="button";button.className="chip";button.textContent=tag;
      button.addEventListener("click",function(){
        state.tag=state.tag===tag?"":tag;
        renderTagChips();renderGrid();
      });
      if(state.tag===tag)button.classList.add("active");
      els.tagChips.appendChild(button);
    });
  }

  function bindEvents(){
    els.searchInput.addEventListener("input",function(){
      state.query=els.searchInput.value.trim().toLowerCase();
      renderGrid();
    });
    els.previewBtn.addEventListener("click",previewHero);
    els.applyBtn.addEventListener("click",applyHero);
    els.studioBtn.addEventListener("click",function(){
      if(!state.hero)return;
      window.location.href="../?companion="+encodeURIComponent(state.hero.id);
    });
  }

  /* ---- Creature DOM ------------------------------------------------------ */
  function createCreature(){
    var el=document.createElement("div");
    el.className="shimeji";
    el.innerHTML=
      '<div class="shimeji-shadow"></div>'+
      '<div class="shimeji-core">'+
        '<div class="shimeji-ear shimeji-ear-left"></div><div class="shimeji-ear shimeji-ear-right"></div>'+
        '<div class="shimeji-arm shimeji-arm-left"></div><div class="shimeji-arm shimeji-arm-right"></div>'+
        '<div class="shimeji-body"></div>'+
        '<div class="shimeji-face"><span class="shimeji-eye shimeji-eye-left"></span><span class="shimeji-eye shimeji-eye-right"></span><span class="shimeji-mouth"></span></div>'+
        '<div class="shimeji-foot shimeji-foot-left"></div><div class="shimeji-foot shimeji-foot-right"></div>'+
        '<div class="shimeji-topper"></div>'+
      '</div>';
    return el;
  }

  function styleCreature(el,pet,em,mode){
    el.style.setProperty("--pet-em",Math.round(em*(Number(pet.scale)||1))+"px");
    el.setAttribute("data-skin",pet.skin||"companion");
    el.setAttribute("data-palette",pet.palette||"blue");
    el.setAttribute("data-mode",mode||motionMode(pet.motion));
  }

  function motionMode(motion){
    if(motion==="float"||motion==="trail")return "float";
    if(motion==="tap"||motion==="spark")return motion;
    if(motion==="climb"||motion==="peek")return motion==="peek"?"peek":"climb";
    if(motion==="hover")return "hover";
    return "walk";
  }

  /* ---- Ambient background creatures (pure CSS, no JS tick) --------------- */
  function buildAmbient(){
    var picks=state.pets.filter(function(item,index){return index%3===1;}).slice(0,2);
    picks.forEach(function(pet,index){
      var wrap=document.createElement("div");
      wrap.className="ambient";
      wrap.style.top=(30+index*90)+"px";
      wrap.style.animation="pet-wander-"+index+" "+(14+index*4)+"s linear infinite";
      var style=document.createElement("style");
      var distance=180+index*60;
      style.textContent="@keyframes pet-wander-"+index+"{0%{transform:translateX(-40px) scaleX(1)}"+
        "49%{transform:translateX("+distance+"px) scaleX(1)}"+
        "50%{transform:translateX("+distance+"px) scaleX(-1)}"+
        "99%{transform:translateX(-40px) scaleX(-1)}100%{transform:translateX(-40px) scaleX(1)}}";
      document.head.appendChild(style);
      var creature=createCreature();
      styleCreature(creature,pet.pet,44,motionMode(pet.pet.motion));
      wrap.appendChild(creature);
      els.stage.appendChild(wrap);
    });
  }

  /* ---- Hero (interactive, JS-driven) -------------------------------------- */
  function setupHero(){
    heroActor=document.createElement("div");
    heroActor.style.position="absolute";heroActor.style.left="0";heroActor.style.top="0";heroActor.style.willChange="transform";
    heroCreature=createCreature();
    heroCreature.className+=" interactive";
    heroActor.appendChild(heroCreature);
    els.stage.appendChild(heroActor);
    heroCreature.addEventListener("pointerdown",startDrag);
    window.addEventListener("pointermove",dragMove);
    window.addEventListener("pointerup",endDrag);
  }

  function selectHero(pet){
    if(!pet)return;
    state.hero=pet;
    state.mode=motionMode(pet.pet.motion);
    styleCreature(heroCreature,pet.pet,84,state.mode);
    els.heroName.textContent=pet.companion_name;
    els.heroMeta.textContent="shimeji-web / "+(pet.pet.motion||"walk")+" / "+(pet.pet.palette||"blue");
    els.heroTags.innerHTML="";
    (pet.tags||[]).slice(0,5).forEach(function(tag){
      var span=document.createElement("span");span.className="tag";span.textContent=tag;els.heroTags.appendChild(span);
    });
    setConsole("Ready","drag the pet, or pick another below.");
    renderGrid();
  }

  function renderGrid(){
    var query=state.query,tag=state.tag;
    var list=state.pets.filter(function(item){
      if(tag&&(item.tags||[]).indexOf(tag)<0)return false;
      if(!query)return true;
      var haystack=[item.companion_name,item.companion_summary,item.id,(item.tags||[]).join(" ")].join(" ").toLowerCase();
      return haystack.indexOf(query)>=0;
    });
    els.grid.innerHTML="";
    list.forEach(function(item){
      var card=document.createElement("button");
      card.type="button";
      card.className="card"+(state.hero&&state.hero.id===item.id?" active":"");
      var cardStage=document.createElement("div");
      cardStage.className="card-stage";
      var floor=document.createElement("div");floor.className="floor";cardStage.appendChild(floor);
      var creature=createCreature();
      styleCreature(creature,item.pet,40,motionMode(item.pet.motion));
      var creatureWrap=document.createElement("div");
      creatureWrap.style.position="absolute";creatureWrap.style.left="34%";creatureWrap.style.top="8px";
      creatureWrap.appendChild(creature);
      cardStage.appendChild(creatureWrap);
      var body=document.createElement("div");
      body.className="card-body";
      body.innerHTML='<strong></strong><p></p><div class="card-meta"><span class="tag"></span><span class="card-dot"></span></div>';
      body.querySelector("strong").textContent=item.companion_name;
      body.querySelector("p").textContent=item.companion_summary;
      body.querySelector(".card-meta .tag").textContent=item.pet.motion||"walk";
      body.querySelector(".card-dot").style.background=PALETTE_HEX[item.pet.palette]||PALETTE_HEX.blue;
      card.appendChild(cardStage);
      card.appendChild(body);
      card.addEventListener("click",function(){
        selectHero(item);
        els.stage.scrollIntoView({behavior:"smooth",block:"center"});
      });
      els.grid.appendChild(card);
    });
  }

  /* ---- Hero physics (mirrors the pet studio's tick loop) ------------------ */
  function tick(time){
    var rect=els.stage.getBoundingClientRect();
    if(!state.last)state.last=time;
    var dt=Math.min((time-state.last)/1000,.04);state.last=time;
    if(!state.drag&&rect.width>0&&rect.height>0){
      if(time>state.nextModeAt){
        state.mode=randomMode(state.hero?state.hero.pet.motion:"walk");
        state.nextModeAt=time+1800+Math.random()*2600;
        heroCreature.setAttribute("data-mode",state.mode);
      }
      var floorY=Math.max(30,rect.height-150);
      if(state.mode==="walk"){
        state.x+=state.vx*state.dir*dt;
        state.y+=(floorY-state.y)*Math.min(1,dt*8);
      }else if(state.mode==="climb"){
        state.y-=36*dt;
        if(state.y<12){state.mode="fall";heroCreature.setAttribute("data-mode","idle");}
      }else if(state.mode==="fall"){
        state.y+=210*dt;
        if(state.y>floorY){state.y=floorY;state.mode="walk";heroCreature.setAttribute("data-mode","walk");}
      }else{
        state.y+=(floorY-state.y)*Math.min(1,dt*2);
      }
      if(state.x<8){state.x=8;state.dir=1}
      if(state.x>rect.width-96){state.x=rect.width-96;state.dir=-1}
      positionHero();
    }
    window.requestAnimationFrame(tick);
  }

  function randomMode(motion){
    if(motion==="climb"||motion==="peek")return Math.random()<.38?"climb":"walk";
    if(motion==="float"||motion==="trail"||motion==="hover")return Math.random()<.5?"float":"walk";
    if(motion==="spark"||motion==="tap")return Math.random()<.42?"wave":motion;
    return Math.random()<.22?"idle":"walk";
  }

  function positionHero(){
    heroActor.style.transform="translate("+state.x+"px,"+state.y+"px) scaleX("+state.dir+")";
  }

  function startDrag(event){
    state.drag=true;heroCreature.classList.add("dragging");heroCreature.setPointerCapture(event.pointerId);
    moveToPointer(event);
  }
  function dragMove(event){if(!state.drag)return;moveToPointer(event);}
  function endDrag(){
    if(!state.drag)return;
    state.drag=false;heroCreature.classList.remove("dragging");
    state.mode=motionMode(state.hero?state.hero.pet.motion:"walk");
    heroCreature.setAttribute("data-mode",state.mode);
  }
  function moveToPointer(event){
    var rect=els.stage.getBoundingClientRect();
    state.x=event.clientX-rect.left-42;state.y=event.clientY-rect.top-46;
    state.x=Math.max(8,Math.min(state.x,Math.max(8,rect.width-96)));
    state.y=Math.max(8,Math.min(state.y,Math.max(8,rect.height-118)));
    positionHero();
  }

  /* ---- Gateway actions (best-effort; never hold credentials here) -------- */
  async function previewHero(){
    if(!state.hero)return;
    setConsole("Previewing",state.hero.companion_name);
    try{
      var res=await window.fetch("/api/pets/preview",{method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({companion_id:state.hero.companion_id})});
      var data=await res.json().catch(function(){return {};});
      if(!res.ok)throw new Error(data.error||"Preview failed");
      setConsole("Preview",data.sample_text||state.hero.companion_name);
    }catch(err){
      setConsole("Preview",state.hero.companion_summary||state.hero.companion_name);
    }
  }

  async function applyHero(){
    if(!state.hero)return;
    setConsole("Applying",state.hero.companion_name);
    try{
      var res=await window.fetch("/api/pets/apply",{method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({companion_id:state.hero.companion_id,scope:"global",source:"website-pet-library"})});
      var data=await res.json().catch(function(){return {};});
      if(!res.ok)throw new Error(data.error||"Apply failed");
      setConsole("Applied",(data.profile&&data.profile.active_companion_name)||state.hero.companion_name);
    }catch(err){
      setConsole("Apply blocked",err.message||"Gateway unavailable — no credentials are held on this page.");
    }
  }

  function setConsole(title,line){els.consoleTitle.textContent=title;els.consoleLine.textContent="— "+(line||"");}

  return {ready,state,els,FALLBACK_PETS,petRecord,normalizePet,loadPets,pickFromUrl,renderTagChips,createCreature,styleCreature,motionMode,buildAmbient,selectHero,renderGrid,tick,randomMode,positionHero,startDrag,dragMove,endDrag,moveToPointer,previewHero,applyHero,setConsole};
}

if(typeof window!=="undefined"&&window.document){
  createPetLibraryApp(window);
}
