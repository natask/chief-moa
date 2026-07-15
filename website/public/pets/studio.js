export function createPetStudio(window,document){
  var navigator=window.navigator;
  var fetch=window.fetch.bind(window);
  var requestAnimationFrame=window.requestAnimationFrame.bind(window);
  var FileReader=window.FileReader;
  var WebSocket=window.WebSocket;
  function firstTruthy(){
    for(var i=0;i<arguments.length;i++)if(arguments[i])return arguments[i];
    return arguments[arguments.length-1];
  }
  var palettes={
    graphite:"#555a62",green:"#208553",blue:"#2f67d8",violet:"#7651c7",
    red:"#d84a39",amber:"#c57a1b",teal:"#0e7d85",mono:"#f6f3ea"
  };
  var motions=["walk","peek","climb","tap","trail","float","spark"];
  // Fallback voice catalog, replaced at load by GET /api/profile/options (the
  // gateway's canonical profile-options VOICE_OPTIONS). The id is sent as the
  // per-session `voice` override on session_start and to /api/voice/synthesize.
  var voices=[
    {id:"Puck",hint:"Bright, quick, and upbeat"},
    {id:"Charon",hint:"Lower, steady, and direct"},
    {id:"Kore",hint:"Clear, measured, and composed"},
    {id:"Fenrir",hint:"Firm, low, and grounded"},
    {id:"Aoede",hint:"Warm, smooth, and expressive"},
    {id:"Leda",hint:"Light, calm, and soft"},
    {id:"Orus",hint:"Clear, formal, and controlled"},
    {id:"Zephyr",hint:"Airy, gentle, and relaxed"}
  ];
  var localAgentsKey="moa.petStudio.agents.v1";
  var deviceIdKey="moa.petStudio.deviceId.v1";

  // Describe-it heuristics: map free-text prompts to the studio's existing
  // palette/motion/voice vocabulary. Used only as a fallback when the gateway's
  // server-side derivation (POST /v1/agent/pets {text}) is unavailable.
  var PALETTE_HINTS=[
    {re:/red|crimson|fire|flame|ember|ruby|scarlet|lava/,value:"red"},
    {re:/green|forest|leaf|moss|emerald|jade|vine|frog/,value:"green"},
    {re:/blue|ocean|sky|water|azure|sea|frost|ice|glacier/,value:"blue"},
    {re:/violet|purple|lavender|magic|mystic|amethyst|arcane|wizard/,value:"violet"},
    {re:/amber|gold|orange|\bsun\b|honey|bronze|autumn|fox\b/,value:"amber"},
    {re:/teal|cyan|aqua|mint|turquoise/,value:"teal"},
    {re:/graphite|gray|grey|stone|steel|shadow|iron|slate|robot/,value:"graphite"},
    {re:/white|mono|ghost|snow|cloud|pearl|ivory|angel/,value:"mono"}
  ];
  var MOTION_HINTS=[
    {re:/fly|float|hover|ghost|cloud|dream|drift|angel|balloon|spirit/,value:"float"},
    {re:/climb|peek|shy|hide|spy|scout|sneak|lurk|guard|watch/,value:"peek"},
    {re:/spark|energetic|hyper|zap|electric|zoom|lightning|manic/,value:"spark"},
    {re:/bounce|playful|happy|jump|hop|excited|tap|cheer/,value:"tap"},
    {re:/trail|wander|roam|explore|travel|nomad/,value:"trail"}
  ];
  var VOICE_HINTS=[
    {re:/soft|calm|gentle|quiet|shy|whisper|soothing|tender|sleepy/,value:"Leda"},
    {re:/warm|friendly|kind|expressive|smooth|cozy/,value:"Aoede"},
    {re:/deep|low|gruff|strong|firm|grounded|bold|fierce|gruff/,value:"Fenrir"},
    {re:/formal|serious|professional|precise|composed|butler/,value:"Orus"},
    {re:/bright|happy|upbeat|energetic|playful|cheerful|quick/,value:"Puck"},
    {re:/steady|direct|confident|matter-of-fact/,value:"Charon"},
    {re:/airy|relaxed|chill|breezy|light|mellow/,value:"Zephyr"}
  ];
  var NAME_STOPWORDS=["that","who","which","with","and","for","the","this","really","very",
    "some","kind","sort","type","character","companion","pet","little","small","big","cute"];
  var fallbackPets=[
    petRecord("shigmi-steward","Shigmi Steward","Default operator","graphite","hover","steward"),
    petRecord("shigmi-scout","Shigmi Scout","Research and discovery","green","peek","scout"),
    petRecord("shigmi-builder","Shigmi Builder","Implementation companion","blue","tap","builder"),
    petRecord("shigmi-scribe","Shigmi Scribe","Writing companion","violet","trail","scribe")
  ];
  var state={
    pets:[],selected:null,query:"",palette:"green",motion:"peek",scale:1,voice:"Kore",
    imageDataUrl:"",rules:[],x:120,y:120,vx:42,vy:0,dir:1,mode:"walk",drag:false,last:0,nextModeAt:0,
    pointerStart:null,holdTimer:null,holdTalk:false,
    // My-agent dashboard state: which view is open, the applied companion (raw
    // gateway record kept for the set-default apply), the profile's default
    // voice, replay pace, and the session's stored turns.
    view:"agent",activeId:"",activeRaw:null,defaultVoice:"",rate:1,turns:[],replayOffer:null
  };

  // One reply plays at a time: `key` identifies what is playing
  // ("<turn>:original" or "<turn>:revoice:<Voice>"); a second click stops it.
  var player={ctx:null,src:null,key:""};

  // Voice turn state: idle -> listening (mic streaming) -> thinking (committed,
  // waiting on the gateway) -> speaking (reply audio playing) -> idle.
  var voice={
    state:"idle",ws:null,ctx:null,mediaStream:null,sourceNode:null,processor:null,
    turnId:"",playHead:0,audioDone:false,gotReplyAudio:false,turnDone:false,
    pending:[],commitQueued:false,finishTimer:null,replyText:"",playbackRate:1
  };

  var els={
    catalog:document.getElementById("catalog"),
    catalogStatus:document.getElementById("catalogStatus"),
    apiStatus:document.getElementById("apiStatus"),
    search:document.getElementById("searchInput"),
    selectedName:document.getElementById("selectedName"),
    selectedMeta:document.getElementById("selectedMeta"),
    consoleTitle:document.getElementById("consoleTitle"),
    consoleLine:document.getElementById("consoleLine"),
    shareLine:document.getElementById("shareLine"),
    shareUrl:document.getElementById("shareUrl"),
    behaviorBar:document.getElementById("behaviorBar"),
    stage:document.getElementById("stage"),
    pet:document.getElementById("pet"),
    petImage:document.getElementById("petImage"),
    petName:document.getElementById("petName"),
    petPrompt:document.getElementById("petPrompt"),
    paletteControls:document.getElementById("paletteControls"),
    motionControls:document.getElementById("motionControls"),
    voiceControls:document.getElementById("voiceControls"),
    voiceStatus:document.getElementById("voiceStatus"),
    talkBtn:document.getElementById("talkBtn"),
    scaleInput:document.getElementById("scaleInput"),
    scaleOutput:document.getElementById("scaleOutput"),
    imageInput:document.getElementById("imageInput"),
    fileName:document.getElementById("fileName"),
    ruleList:document.getElementById("ruleList"),
    addRuleBtn:document.getElementById("addRuleBtn"),
    form:document.getElementById("petForm"),
    hint:document.getElementById("formHint"),
    previewBtn:document.getElementById("previewBtn"),
    shareBtn:document.getElementById("shareBtn"),
    applyBtn:document.getElementById("applyBtn"),
    publishBtn:document.getElementById("publishBtn"),
    generateBtn:document.getElementById("generateBtn"),
    describeInput:document.getElementById("describeInput"),
    describeBtn:document.getElementById("describeBtn"),
    describeApplyBtn:document.getElementById("describeApplyBtn"),
    describeStatus:document.getElementById("describeStatus"),
    library:document.getElementById("library"),
    libraryStatus:document.getElementById("libraryStatus"),
    libraryList:document.getElementById("libraryList"),
    libraryEmpty:document.getElementById("libraryEmpty"),
    tabAgent:document.getElementById("tabAgent"),
    tabStudio:document.getElementById("tabStudio"),
    voiceList:document.getElementById("voiceList"),
    voicePanelDefault:document.getElementById("voicePanelDefault"),
    voiceHint:document.getElementById("voiceHint"),
    defaultVoiceBtn:document.getElementById("defaultVoiceBtn"),
    rateInput:document.getElementById("rateInput"),
    rateOutput:document.getElementById("rateOutput"),
    tape:document.getElementById("tape"),
    tapeStatus:document.getElementById("tapeStatus"),
    tapeNote:document.getElementById("tapeNote")
  };

  // Feature flags: the shared-library + publish gateway routes may not exist yet
  // (the site can deploy before or after the gateway). We enable each only after
  // a non-404 probe, and hide the UI otherwise.
  var features={sharedLibrary:false,publish:false};
  var sharedItems=[];

  initControls();
  bindEvents();
  renderVoicePanel();
  if(window.location.hash==="#studio")setView("studio");
  loadPets();
  loadVoiceOptions();
  loadSharedLibrary();
  requestAnimationFrame(tick);

  function petRecord(id,name,summary,palette,motion,skin){
    return {
      id:id,companion_id:id,companion_name:name,companion_summary:summary,source:"builtin",
      tags:["shigmi"],voice:"Kore",
      pet:{
        renderer:"shimeji-web",family:"shigmi",skin:skin,palette:palette,motion:motion,scale:1,
        sprite:{type:"css-shigmi",frame_width:96,frame_height:96,frame_count:1},
        behaviors:[
          {id:"idle",label:"Idle"},{id:"walk",label:"Walk"},{id:"climb",label:"Climb"},
          {id:"drag",label:"Drag"},{id:"fall",label:"Fall"}
        ]
      },
      rules:[],
      starters:[]
    };
  }

  function initControls(){
    Object.keys(palettes).forEach(function(key){
      var button=document.createElement("button");
      button.type="button";button.className="swatch";button.style.setProperty("--swatch",palettes[key]);
      button.setAttribute("aria-label",key);button.dataset.palette=key;
      els.paletteControls.appendChild(button);
    });
    motions.forEach(function(key){
      var button=document.createElement("button");
      button.type="button";button.className="seg";button.textContent=key;button.dataset.motion=key;
      els.motionControls.appendChild(button);
    });
    renderStudioVoices();
    refreshControlState();
  }

  function renderStudioVoices(){
    els.voiceControls.innerHTML="";
    voices.forEach(function(item){
      var button=document.createElement("button");
      button.type="button";button.className="seg";button.textContent=item.id;button.title=item.hint;button.dataset.voice=item.id;
      els.voiceControls.appendChild(button);
    });
  }

  // Canonical voice catalog from the gateway (labels + descriptions), so the
  // page never drifts from profile-options VOICE_OPTIONS. Falls back to the
  // baked-in list when the proxy or gateway is unavailable.
  async function loadVoiceOptions(){
    try{
      var res=await fetch("/api/profile/options",{headers:{"accept":"application/json"}});
      if(!res.ok)return;
      var data=await res.json().catch(function(){return {};});
      if([!Array.isArray(data.voices),!data.voices?.length].some(Boolean))return;
      voices=data.voices.map(function(item){
        return {
          id:String(firstTruthy(item.id,"")),
          hint:String(firstTruthy(item.description,firstTruthy(item.tone_tags,[]).join(", "),"")),
          presentation:String(firstTruthy(item.presentation,""))
        };
      }).filter(function(item){return item.id;});
      renderStudioVoices();
      refreshControlState();
      renderVoicePanel();
    }catch(err){}
  }

  function bindEvents(){
    els.search.addEventListener("input",function(){state.query=els.search.value.trim().toLowerCase();renderCatalog();});
    els.paletteControls.addEventListener("click",function(event){
      var button=event.target.closest("[data-palette]");if(!button)return;
      state.palette=button.dataset.palette;applyControlsToPreview();refreshControlState();
    });
    els.motionControls.addEventListener("click",function(event){
      var button=event.target.closest("[data-motion]");if(!button)return;
      state.motion=button.dataset.motion;state.mode=motionMode(state.motion);applyControlsToPreview();refreshControlState();
    });
    els.voiceControls.addEventListener("click",function(event){
      var button=event.target.closest("[data-voice]");if(!button)return;
      chooseVoice(button.dataset.voice);
    });
    els.voiceList.addEventListener("click",function(event){
      var button=event.target.closest("[data-voice]");if(!button)return;
      chooseVoice(button.dataset.voice);
    });
    els.tabAgent.addEventListener("click",function(){setView("agent");});
    els.tabStudio.addEventListener("click",function(){setView("studio");});
    els.defaultVoiceBtn.addEventListener("click",makeDefaultVoice);
    els.rateInput.addEventListener("input",function(){
      state.rate=firstTruthy(Number(els.rateInput.value),1);
      els.rateOutput.textContent=state.rate===1?"auto":state.rate.toFixed(2)+"x";
    });
    els.tape.addEventListener("click",function(event){
      var button=event.target.closest("[data-act]");if(!button)return;
      var row=button.closest("[data-turn-id]");if(!row)return;
      var turn=findTurn(row.dataset.turnId);if(!turn)return;
      playTurnAudio(turn,button.dataset.act);
    });
    els.talkBtn.addEventListener("click",toggleTalk);
    window.addEventListener("keydown",function(event){
      if(event.key==="Escape"&&voice.state!=="idle")cancelVoiceTurn();
    });
    els.scaleInput.addEventListener("input",function(){
      state.scale=firstTruthy(Number(els.scaleInput.value),1);applyPetVisual();refreshControlState();
    });
    els.imageInput.addEventListener("change",handleImageUpload);
    els.ruleList.addEventListener("input",updateRulesFromDom);
    els.ruleList.addEventListener("change",updateRulesFromDom);
    els.ruleList.addEventListener("click",removeRule);
    els.addRuleBtn.addEventListener("click",addRule);
    els.form.addEventListener("submit",createPet);
    els.previewBtn.addEventListener("click",previewSelected);
    els.shareBtn.addEventListener("click",bookmarkSelected);
    els.applyBtn.addEventListener("click",applySelected);
    els.publishBtn.addEventListener("click",publishSelected);
    els.generateBtn.addEventListener("click",generateImage);
    els.describeBtn.addEventListener("click",describeCharacter);
    els.describeApplyBtn.addEventListener("click",applyDescribedCharacter);
    els.describeInput.addEventListener("keydown",function(event){
      if(event.key==="Enter"){event.preventDefault();describeCharacter();}
    });
    els.libraryList.addEventListener("click",onLibraryClick);
    els.pet.addEventListener("pointerdown",startDrag);
    window.addEventListener("pointermove",dragMove);
    window.addEventListener("pointerup",endDrag);
  }

  async function loadPets(){
    var searchParams=new URLSearchParams(window.location.search);
    var requestedAgent=firstTruthy(searchParams.get("agent"),searchParams.get("companion"));
    try{
      var res=await fetch("/api/pets",{headers:{"accept":"application/json"}});
      if(!res.ok)throw new Error("HTTP "+res.status);
      var data=await res.json();
      state.pets=mergePets(firstTruthy(data.pets,[]).map(normalizePet),getLocalAgents());
      els.catalogStatus.textContent=String(state.pets.length);
      els.apiStatus.textContent=data.generation&&data.generation.configured?"Vertex":"Gateway";
    }catch(err){
      state.pets=mergePets(fallbackPets,getLocalAgents());
      els.catalogStatus.textContent="Local";
      els.apiStatus.textContent="Local";
    }
    await loadActiveAgent();
    if(requestedAgent){
      // A shared /pets/?agent= link is explicit intent to inspect that agent:
      // land in the studio with it selected, as before this redesign.
      setView("studio");
      var loaded=await loadAgent(requestedAgent);
      if(loaded){selectPet(loaded);}
      else{selectPet(firstTruthy(findPet(requestedAgent),state.pets[0]));}
    }else{
      selectPet(firstTruthy(findPet(state.activeId),state.pets[0]));
    }
    renderCatalog();
  }

  // The applied companion is the dashboard's subject. /api/pets/active returns
  // it together with profile_voice — the profile's effective default voice —
  // and the raw companion record we resend on "Set as default".
  async function loadActiveAgent(){
    try{
      var res=await fetch("/api/pets/active",{headers:{"accept":"application/json"}});
      if(!res.ok)throw new Error("HTTP "+res.status);
      var data=await res.json().catch(function(){return {};});
      var active=firstTruthy(data.active_companion,null);
      state.activeRaw=firstTruthy(active&&active.companion,null);
      var record=null;
      if(state.activeRaw){record=normalizePet(state.activeRaw);}
      else if(active&&active.pet){record=normalizePet(active.pet);}
      if(record&&record.id){
        state.activeId=record.id;
        upsertPet(record);
      }
      state.defaultVoice=firstTruthy(canonicalVoiceId(data.profile_voice),
        record?voiceBindingVoice(record):"",state.defaultVoice);
    }catch(err){}
    renderVoicePanel();
  }

  function normalizePet(item){
    var companion=firstTruthy(item.companion,item);
    var pet=firstTruthy(item.pet,companion.pet,{});
    return {
      id:firstTruthy(item.id,item.companion_id,companion.id),
      companion_id:firstTruthy(item.companion_id,companion.id,item.id),
      companion_name:firstTruthy(item.companion_name,companion.name,"Custom pet"),
      companion_summary:firstTruthy(item.companion_summary,companion.summary,""),
      source:firstTruthy(item.source,companion.source,"custom"),
      tags:firstTruthy(item.tags,companion.tags,[]),
      voice:firstTruthy(item.voice,companion.voice,""),
      voice_binding:firstTruthy(item.voice_binding,companion.voice_binding,null),
      voice_clone:firstTruthy(item.voice_clone,companion.voice_clone,null),
      pet:{
        renderer:firstTruthy(pet.renderer,"shimeji-web"),
        family:firstTruthy(pet.family,"shigmi"),
        skin:firstTruthy(pet.skin,"companion"),
        palette:firstTruthy(pet.palette,"blue"),
        motion:firstTruthy(pet.motion,"walk"),
        scale:firstTruthy(Number(pet.scale),1),
        sprite:firstTruthy(pet.sprite,{type:"css-shigmi"}),
        behaviors:firstTruthy(pet.behaviors,[])
      },
      rules:sanitizeRules(firstTruthy(item.rules,companion.rules,[])),
      starters:firstTruthy(item.starters,companion.starters,[])
    };
  }

  async function loadAgent(id){
    var existing=findPet(id);
    try{
      var res=await fetch("/api/pets/agents/"+encodeURIComponent(id),{headers:{"accept":"application/json"}});
      var data=await res.json().catch(function(){return {};});
      if(!res.ok)throw new Error(firstTruthy(data.error,"Load failed"));
      var agent=normalizePet(firstTruthy(data.agent,data.pet,data.companion,data));
      upsertPet(agent);
      return agent;
    }catch(err){
      var local=firstTruthy(findLocalAgent(id),existing);
      if(!local)setConsole("Load blocked",firstTruthy(err.message,"Gateway unavailable"));
      return firstTruthy(local,null);
    }
  }

  function mergePets(primary,local){
    var seen={};
    return primary.concat(local).filter(function(item){
      if(!item||!item.id||seen[item.id])return false;
      seen[item.id]=true;
      return true;
    });
  }

  function upsertPet(item){
    state.pets=state.pets.filter(function(existing){return existing.id!==item.id;});
    state.pets.unshift(item);
    renderCatalog();
  }

  function findPet(id){
    return firstTruthy(state.pets.filter(function(item){return [item.id,item.companion_id].includes(id);})[0],null);
  }

  function getLocalAgents(){
    try{
      var parsed=JSON.parse(firstTruthy(window.localStorage.getItem(localAgentsKey),"[]"));
      return Array.isArray(parsed)?parsed.map(normalizePet):[];
    }catch(err){
      return [];
    }
  }

  function findLocalAgent(id){
    return firstTruthy(getLocalAgents().filter(function(item){return [item.id,item.companion_id].includes(id);})[0],null);
  }

  function saveLocalAgent(item){
    try{
      var list=getLocalAgents().filter(function(existing){return existing.id!==item.id;});
      list.unshift(item);
      window.localStorage.setItem(localAgentsKey,JSON.stringify(list.slice(0,20)));
    }catch(err){}
  }

  function addRule(){
    state.rules=collectRules(true);
    state.rules.push({id:"rule-"+Date.now().toString(36),trigger:"",action:"",enabled:true,summary:""});
    renderRules();
  }

  function removeRule(event){
    var button=event.target.closest(".rule-remove");
    if(!button)return;
    var row=button.closest(".rule-row");
    state.rules=collectRules(true).filter(function(rule){return rule.id!==(row&&row.dataset.ruleId);});
    renderRules();
  }

  function updateRulesFromDom(){
    state.rules=collectRules(true);
  }

  function renderRules(){
    els.ruleList.innerHTML="";
    state.rules.forEach(function(rule){
      var row=document.createElement("div");
      row.className="rule-row";
      row.dataset.ruleId=rule.id;
      row.innerHTML='<label class="rule-enabled"><input class="rule-on" type="checkbox" /><span>On</span></label><input class="rule-trigger" type="text" maxlength="120" placeholder="Trigger" /><input class="rule-action" type="text" maxlength="180" placeholder="Action" /><button class="icon-btn rule-remove" type="button" aria-label="Remove rule">x</button>';
      row.querySelector(".rule-on").checked=rule.enabled!==false;
      row.querySelector(".rule-trigger").value=firstTruthy(rule.trigger,"");
      row.querySelector(".rule-action").value=firstTruthy(rule.action,"");
      els.ruleList.appendChild(row);
    });
  }

  function collectRules(keepBlank){
    return Array.prototype.map.call(els.ruleList.querySelectorAll(".rule-row"),function(row,index){
      var trigger=cleanText(row.querySelector(".rule-trigger").value,120);
      var action=cleanText(row.querySelector(".rule-action").value,180);
      return {
        id:firstTruthy(cleanText(row.dataset.ruleId,80),"rule-"+index),
        trigger:trigger,
        action:action,
        enabled:row.querySelector(".rule-on").checked,
        summary:cleanText(trigger+" -> "+action,220)
      };
    }).filter(function(rule){return [keepBlank,rule.trigger,rule.action].some(Boolean);}).slice(0,12);
  }

  function readRules(){
    state.rules=collectRules(false);
    return state.rules;
  }

  function sanitizeRules(rules){
    if(!Array.isArray(rules))return [];
    return rules.map(function(rule,index){
      var trigger=cleanText(rule&&rule.trigger,120);
      var action=cleanText(rule&&rule.action,180);
      return {
        id:firstTruthy(cleanText(rule&&rule.id,80),"rule-"+index),
        trigger:trigger,
        action:action,
        enabled:rule?rule.enabled!==false:true,
        summary:firstTruthy(cleanText(rule&&rule.summary,220),cleanText(trigger+" -> "+action,220))
      };
    }).filter(function(rule){return [rule.trigger,rule.action].some(Boolean);}).slice(0,12);
  }

  function cleanText(value,max){
    return String(firstTruthy(value,"")).replace(/[\u0000-\u001f\u007f]/g," ").replace(/\s+/g," ").trim().slice(0,max);
  }

  function agentUrl(id){
    return "/pets/?agent="+encodeURIComponent(id);
  }

  function cleanBookmarkUrl(value,id){
    try{
      var url=new URL(value,window.location.origin);
      return agentUrl(firstTruthy(url.searchParams.get("agent"),id));
    }catch(err){
      return agentUrl(id);
    }
  }

  function showShareUrl(url){
    els.shareUrl.value=url;
    els.shareLine.classList.add("visible");
    window.history.replaceState({}, "", url);
    els.shareUrl.focus();
    els.shareUrl.select();
  }

  function renderCatalog(){
    var list=state.pets.filter(function(item){
      if(!state.query)return true;
      return [item.companion_name,item.companion_summary,item.id,firstTruthy(item.tags,[]).join(" ")].join(" ").toLowerCase().indexOf(state.query)>=0;
    });
    els.catalog.innerHTML="";
    list.forEach(function(item){
      var button=document.createElement("button");
      button.type="button";
      button.className="pet-row"+(state.selected&&state.selected.id===item.id?" active":"");
      button.innerHTML='<span class="mini"><span class="mini-dot"></span></span><span class="pet-copy"><strong></strong><span class="pet-meta"></span></span>';
      button.querySelector("strong").textContent=item.companion_name;
      button.querySelector(".pet-meta").textContent=firstTruthy(item.pet.motion,"walk")+" / "+firstTruthy(item.source,"custom");
      button.querySelector(".mini-dot").style.background=firstTruthy(palettes[item.pet.palette],palettes.blue);
      button.addEventListener("click",function(){selectPet(item);});
      els.catalog.appendChild(button);
    });
  }

  function selectPet(item){
    if(!item)return;
    if(voice.state!=="idle")cancelVoiceTurn();
    stopPlayback();
    state.selected=item;
    state.palette=firstTruthy(item.pet.palette,"blue");
    state.motion=firstTruthy(item.pet.motion,"walk");
    // The applied agent speaks with the profile's default voice unless the
    // user picks another one here; other pets preview their own binding.
    state.voice=firstTruthy(item.id===state.activeId&&state.defaultVoice,voiceBindingVoice(item));
    state.scale=firstTruthy(Number(item.pet.scale),1);
    state.mode=motionMode(state.motion);
    state.imageDataUrl=firstTruthy(item.pet.sprite&&item.pet.sprite.image_data_url,"");
    state.rules=sanitizeRules(firstTruthy(item.rules,[]));
    state.replayOffer=null;
    els.petName.value=firstTruthy(item.companion_name,"");
    els.petPrompt.value=firstTruthy(item.companion_summary,els.petPrompt.value);
    els.shareLine.classList.remove("visible");
    renderCatalog();
    renderRules();
    applyPetVisual();
    refreshControlState();
    renderVoicePanel();
    updatePublishVisibility();
    loadTurns();
  }

  function applyControlsToPreview(){
    if(state.selected){
      state.selected.pet.palette=state.palette;
      state.selected.pet.motion=state.motion;
      state.selected.pet.scale=state.scale;
      state.selected.voice=state.voice;
      if(state.selected.voice_binding&&typeof state.selected.voice_binding==="object"){
        state.selected.voice_binding.provider_voice_id=state.voice;
        state.selected.voice_binding.legacy_voice=state.voice;
      }
    }
    applyPetVisual();
  }

  function canonicalVoiceId(value){
    var raw=String(firstTruthy(value,"")).trim().toLowerCase();
    var match=voices.filter(function(item){return item.id.toLowerCase()===raw;})[0];
    return match?match.id:"";
  }

  function voiceBinding(item){
    return item&&item.voice_binding&&typeof item.voice_binding==="object"?item.voice_binding:null;
  }

  function voiceBindingVoice(item){
    var binding=voiceBinding(item);
    return firstTruthy(canonicalVoiceId(binding&&binding.provider_voice_id),
      canonicalVoiceId(binding&&binding.legacy_voice),canonicalVoiceId(item&&item.voice),"Kore");
  }

  function customVoiceState(item){
    var binding=voiceBinding(item);
    return binding&&binding.custom_voice&&typeof binding.custom_voice==="object"?binding.custom_voice:null;
  }

  // Clone-job status can arrive on voice_binding.custom_voice.status (the
  // gateway overlays the job status there once a job exists) or on the compact
  // companion.voice_clone.status. Prefer whichever is present.
  function cloneJobStatus(item){
    var custom=customVoiceState(item);
    if(custom&&custom.status)return String(custom.status).toLowerCase();
    var clone=item&&item.voice_clone&&typeof item.voice_clone==="object"?item.voice_clone:null;
    if(clone&&clone.status)return String(clone.status).toLowerCase();
    return "not_configured";
  }

  function voiceReadiness(item){
    var status=cloneJobStatus(item);
    if(status==="ready")return {kind:"ready",label:"Cloned voice ready"};
    // Google voice cloning is allowlist-gated on the current project. Until the
    // allowlist is granted the clone job runs in dry-run and the character falls
    // back to the closest canonical voice — say that honestly, not as an error.
    if(["blocked_allowlist","allowlist_pending","allowlist_blocked"].includes(status))
      return {kind:"waiting",label:"Cloned voice pending Google approval — using closest catalog voice"};
    if(status==="not_implemented_live")
      return {kind:"waiting",label:"Cloned voice pending live enablement — using closest catalog voice"};
    if(["pending","processing","queued","running"].includes(status))
      return {kind:"waiting",label:"Cloned voice processing — using closest catalog voice"};
    if(status==="consent_required")return {kind:"waiting",label:"Cloned voice needs consent"};
    if(status==="error")return {kind:"error",label:"Cloned voice unavailable — using closest catalog voice"};
    var custom=customVoiceState(item);
    if(custom&&custom.access_required===true)
      return {kind:"waiting",label:"Cloned voice pending Google approval — using closest catalog voice"};
    return {kind:"waiting",label:"Catalog voice"};
  }

  function renderVoiceStatus(item){
    var readiness=voiceReadiness(item);
    els.voiceStatus.className="voice-status "+readiness.kind;
    els.voiceStatus.textContent=state.voice+" · "+readiness.label;
  }

  function applyPetVisual(){
    var selected=firstTruthy(state.selected,fallbackPets[0]);
    var pet=firstTruthy(selected.pet,{});
    var palette=firstTruthy(state.palette,pet.palette,"blue");
    var motion=firstTruthy(state.motion,pet.motion,"walk");
    state.scale=Number(firstTruthy(state.scale,pet.scale,1));
    els.selectedName.textContent=firstTruthy(selected.companion_name,"Custom pet");
    els.selectedMeta.textContent=state.view==="agent"
      ?("speaks as "+state.voice+(state.defaultVoice
        ?(state.defaultVoice===state.voice?" (default)":" · default "+state.defaultVoice)
        :""))
      :(firstTruthy(pet.renderer,"shimeji-web")+" / "+motion+" / "+palette+" / "+state.voice);
    els.scaleInput.value=String(state.scale);
    els.scaleOutput.textContent=state.scale.toFixed(2);
    els.pet.className="pet palette-"+palette+" mode-"+state.mode+(state.imageDataUrl?" has-image":"");
    els.petImage.src=firstTruthy(state.imageDataUrl,"");
    renderBehaviors(firstTruthy(pet.behaviors,[]));
    renderVoiceStatus(selected);
  }

  function renderBehaviors(behaviors){
    var list=behaviors.length?behaviors:[{id:"idle"},{id:"walk"},{id:"drag"},{id:"fall"}];
    els.behaviorBar.innerHTML="";
    list.slice(0,7).forEach(function(item){
      var button=document.createElement("button");
      button.type="button";button.className="chip"+(state.mode===item.id?" active":"");
      button.textContent=firstTruthy(item.label,item.id);
      button.addEventListener("click",function(){state.mode=item.id;applyPetVisual();});
      els.behaviorBar.appendChild(button);
    });
  }

  function refreshControlState(){
    Array.prototype.forEach.call(els.paletteControls.children,function(button){
      button.classList.toggle("active",button.dataset.palette===state.palette);
    });
    Array.prototype.forEach.call(els.motionControls.children,function(button){
      button.classList.toggle("active",button.dataset.motion===state.motion);
    });
    Array.prototype.forEach.call(els.voiceControls.children,function(button){
      button.classList.toggle("active",button.dataset.voice===state.voice);
    });
    els.scaleOutput.textContent=firstTruthy(Number(els.scaleInput.value),1).toFixed(2);
    renderVoiceStatus(state.selected);
  }

  // ---- My-agent dashboard: view switch, voice panel, conversation tape. ----

  function setView(next){
    if(state.view===next)return;
    state.view=next;
    document.body.className="view-"+next;
    els.tabAgent.classList.toggle("active",next==="agent");
    els.tabStudio.classList.toggle("active",next==="studio");
    try{
      window.history.replaceState({}, "",
        window.location.pathname+window.location.search+(next==="studio"?"#studio":""));
    }catch(err){}
    if(next==="agent"){
      var record=findPet(state.activeId);
      if(record&&(!state.selected||state.selected.id!==record.id)){
        selectPet(record);
      }else{
        renderVoicePanel();
        loadTurns();
      }
    }
    applyPetVisual();
  }

  function voiceDescription(id){
    var match=voices.filter(function(item){return item.id===id;})[0];
    return firstTruthy(match&&match.hint,"");
  }

  // One voice choice drives everything: the live session override, the studio
  // segments, and the dashboard panel. Changing it while a reply exists offers
  // an instant replay of that reply in the new voice.
  function chooseVoice(id){
    var canonical=canonicalVoiceId(id);
    if(!canonical)return;
    state.voice=canonical;
    applyControlsToPreview();
    refreshControlState();
    setConsole("Voice: "+canonical,voiceDescription(canonical));
    offerReplayInVoice();
    renderVoicePanel();
  }

  function renderVoicePanel(){
    if(!els.voiceList)return;
    els.voicePanelDefault.textContent=state.defaultVoice?("default "+state.defaultVoice):"default —";
    els.voiceList.innerHTML="";
    voices.forEach(function(item){
      var row=document.createElement("button");
      row.type="button";
      row.className="voice-row"+(item.id===state.voice?" active":"");
      row.dataset.voice=item.id;
      row.setAttribute("role","radio");
      row.setAttribute("aria-checked",item.id===state.voice?"true":"false");
      row.innerHTML='<span class="voice-dot"></span><span><span class="voice-name"></span><span class="voice-desc"></span></span><span class="voice-flag"></span>';
      row.querySelector(".voice-name").textContent=item.id;
      row.querySelector(".voice-desc").textContent=firstTruthy(item.hint,"");
      row.querySelector(".voice-flag").textContent=item.id===state.defaultVoice?"default":"";
      els.voiceList.appendChild(row);
    });
    var canDefault=Boolean(state.voice)&&state.voice!==state.defaultVoice;
    els.defaultVoiceBtn.disabled=!canDefault;
    if(canDefault){
      setPanelHint(state.voice+" is set for this session only.","");
    }else if(state.defaultVoice){
      setPanelHint(state.defaultVoice+" is the default voice.","");
    }else{
      setPanelHint("Pick a voice — the next reply uses it.","");
    }
    renderTurns();
  }

  function setPanelHint(text,kind){
    els.voiceHint.textContent=text;
    els.voiceHint.className="hint "+firstTruthy(kind,"");
  }

  // "Set as default" persists through the existing companion apply path: the
  // active companion is re-applied with `voice` on the body, so the profile's
  // default voice changes without touching anything else on the profile.
  async function makeDefaultVoice(){
    var chosen=state.voice;
    if(!chosen||chosen===state.defaultVoice)return;
    var companionId=firstTruthy(state.activeRaw&&state.activeRaw.id,state.activeId);
    if(!companionId){
      setPanelHint("No applied companion yet — open Studio and apply one first.","err");
      return;
    }
    els.defaultVoiceBtn.disabled=true;
    setPanelHint("Setting "+chosen+" as the default…","");
    try{
      var res=await fetch("/api/pets/apply",{
        method:"POST",
        headers:{"content-type":"application/json"},
        body:JSON.stringify({companion_id:companionId,scope:"global",source:"website-pet-studio",voice:chosen})
      });
      var data=await res.json().catch(function(){return {};});
      if(!res.ok)throw new Error(firstTruthy(data.error,"Apply failed"));
      state.defaultVoice=chosen;
      setPanelHint(chosen+" is now "+petDisplayName()+"'s voice everywhere.","ok");
    }catch(err){
      setPanelHint(firstTruthy(err&&err.message,"Could not set the default voice"),"err");
    }
    renderVoicePanel();
    applyPetVisual();
  }

  // ---- Conversation history: stored voice turns for this pet's session. ----

  function turnsSessionId(){
    return voiceSessionId();
  }

  function findTurn(id){
    return firstTruthy(state.turns.filter(function(turn){return turn.turn_id===id;})[0],null);
  }

  async function loadTurns(){
    if(!state.selected||!els.tape)return;
    var sessionId=turnsSessionId();
    try{
      var res=await fetch("/api/voice/turns?session_id="+encodeURIComponent(sessionId)+"&limit=40",
        {headers:{"accept":"application/json"}});
      var data=await res.json().catch(function(){return {};});
      if(!res.ok)throw new Error(firstTruthy(data.error,"HTTP "+res.status));
      state.turns=(Array.isArray(data.turns)?data.turns:[]).filter(function(turn){
        return firstTruthy(turn.transcript&&turn.transcript!=="Voice captured.",turn.reply);
      });
      els.tapeStatus.textContent=state.turns.length?String(state.turns.length)+(state.turns.length===1?" turn":" turns"):"";
      if(state.turns.length)els.tapeNote.textContent="";
      renderTurns();
      els.tape.scrollTop=els.tape.scrollHeight;
    }catch(err){
      state.turns=[];
      els.tapeStatus.textContent="";
      renderTurns();
      els.tapeNote.textContent="History unavailable — "+firstTruthy(err&&err.message,"gateway offline");
    }
  }

  function refreshTurnsSoon(){
    setTimeout(loadTurns,900);
  }

  function renderTurns(){
    if(!els.tape)return;
    els.tape.innerHTML="";
    if(!state.turns.length){
      var empty=document.createElement("div");
      empty.className="tape-empty";
      empty.textContent="No conversation yet. Hold "+petDisplayName()+" — or press Talk — and say something. Every reply lands here, replayable in any voice.";
      els.tape.appendChild(empty);
      return;
    }
    state.turns.forEach(function(turn){
      var row=document.createElement("div");
      row.className="turn";
      row.dataset.turnId=turn.turn_id;
      if(turn.transcript&&turn.transcript!=="Voice captured."){
        var you=document.createElement("div");
        you.className="turn-you";
        you.innerHTML='<span class="turn-tag">you</span><p></p>';
        you.querySelector("p").textContent=turn.transcript;
        row.appendChild(you);
      }
      if(turn.reply){
        var reply=document.createElement("div");
        reply.className="turn-reply";
        reply.innerHTML='<span class="turn-tag"></span><p class="turn-said"></p><div class="turn-foot"><time></time></div>';
        reply.querySelector(".turn-tag").textContent=petDisplayName();
        reply.querySelector(".turn-said").textContent=turn.reply;
        reply.querySelector("time").textContent=formatTurnTime(turn.created_at);
        var foot=reply.querySelector(".turn-foot");
        if(turn.audio&&turn.audio.assistant){
          foot.appendChild(tapeButton(turn,"original","▶ original"));
        }
        var offer=state.replayOffer&&state.replayOffer.turn_id===turn.turn_id;
        var revoiceLabel=offer
          ?("▶ hear it in "+state.voice)
          :("⟳ in "+state.voice);
        var revoice=tapeButton(turn,"revoice",revoiceLabel);
        if(offer)revoice.classList.add("offer");
        foot.appendChild(revoice);
        row.appendChild(reply);
      }
      els.tape.appendChild(row);
    });
  }

  function tapeButton(turn,act,label){
    var button=document.createElement("button");
    button.type="button";
    button.className="tape-btn";
    button.dataset.act=act;
    var key=playKey(turn,act);
    if(player.key===key){
      button.classList.add("playing");
      button.textContent="■ stop";
    }else{
      button.textContent=label;
    }
    return button;
  }

  function formatTurnTime(iso){
    var date=new Date(firstTruthy(iso,""));
    if(isNaN(date.getTime()))return "";
    var now=new Date();
    var sameDay=date.toDateString()===now.toDateString();
    var time=date.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
    return sameDay?time:date.toLocaleDateString([],{month:"short",day:"numeric"})+" "+time;
  }

  // The autonomy moment: a voice change plants a one-click replay on the most
  // recent reply, so the new voice can be heard on words already spoken.
  function offerReplayInVoice(){
    var last=null;
    for(var i=state.turns.length-1;i>=0;i--){
      if(state.turns[i].reply){last=state.turns[i];break;}
    }
    if(!last){
      state.replayOffer=null;
      return;
    }
    state.replayOffer={turn_id:last.turn_id,voice:state.voice};
    renderTurns();
    els.tape.scrollTop=els.tape.scrollHeight;
    els.tapeNote.textContent="New voice picked — replay the last reply to hear "+state.voice+".";
  }

  // ---- PCM playback for stored + re-voiced replies (one at a time). ----

  function playKey(turn,act){
    return turn.turn_id+":"+act+(act==="revoice"?":"+state.voice:"");
  }

  async function playTurnAudio(turn,act){
    var key=playKey(turn,act);
    if(player.key===key){
      stopPlayback();
      renderTurns();
      return;
    }
    stopPlayback();
    player.key=key;
    renderTurns();
    try{
      var buf;
      if(act==="original"){
        var res=await fetch("/api/voice/audio?session_id="+encodeURIComponent(firstTruthy(turn.session_id,turnsSessionId()))
          +"&turn_id="+encodeURIComponent(turn.turn_id)+"&kind=assistant");
        if(!res.ok)throw new Error("Stored audio unavailable ("+res.status+")");
        buf=await res.arrayBuffer();
      }else{
        var body={text:firstTruthy(turn.speak,turn.reply),voice:state.voice};
        if(state.rate!==1)body.speaking_rate=state.rate;
        if(turn.reply_language)body.language=turn.reply_language;
        var synth=await fetch("/api/voice/synthesize",{
          method:"POST",
          headers:{"content-type":"application/json"},
          body:JSON.stringify(body)
        });
        if(!synth.ok){
          var errData=await synth.json().catch(function(){return {};});
          throw new Error(firstTruthy(errData.error,"Couldn't voice that reply ("+synth.status+")"));
        }
        buf=await synth.arrayBuffer();
      }
      if(player.key!==key)return;
      if(act==="revoice"&&state.replayOffer&&state.replayOffer.turn_id===turn.turn_id){
        state.replayOffer=null;
      }
      startPcmPlayback(buf,key);
      els.tapeNote.textContent=act==="revoice"?("Replaying in "+state.voice+"."):"Playing the original reply.";
    }catch(err){
      if(player.key===key)player.key="";
      els.tapeNote.textContent=firstTruthy(err&&err.message,"Playback failed");
      renderTurns();
    }
  }

  function startPcmPlayback(arrayBuffer,key){
    var byteLength=arrayBuffer.byteLength-(arrayBuffer.byteLength%2);
    if(byteLength<=0){
      player.key="";
      els.tapeNote.textContent="No audio came back for that reply.";
      renderTurns();
      return;
    }
    if(!player.ctx)player.ctx=new (firstTruthy(window.AudioContext,window.webkitAudioContext))();
    if(player.ctx.state==="suspended")player.ctx.resume();
    var ints=new Int16Array(arrayBuffer,0,byteLength/2);
    var floats=new Float32Array(ints.length);
    for(var i=0;i<ints.length;i++)floats[i]=ints[i]/32768;
    var buffer=player.ctx.createBuffer(1,floats.length,16000);
    buffer.getChannelData(0).set(floats);
    var src=player.ctx.createBufferSource();
    src.buffer=buffer;
    src.connect(player.ctx.destination);
    src.onended=function(){
      if(player.src===src){
        player.src=null;
        player.key="";
        renderTurns();
      }
    };
    player.src=src;
    player.key=key;
    src.start();
    renderTurns();
  }

  function stopPlayback(){
    if(player.src){
      try{player.src.onended=null;player.src.stop();}catch(err){}
      player.src=null;
    }
    player.key="";
  }

  async function createPet(event){
    event.preventDefault();
    setHint("Creating", "");
    var body=formBody();
    try{
      var res=await fetch("/api/pets/agents",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
      var data=await res.json().catch(function(){return {};});
      if(!res.ok)throw new Error(firstTruthy(data.error,"Create failed"));
      var pet=normalizePet(firstTruthy(data.agent,data.pet,data.companion,data));
      upsertPet(pet);selectPet(pet);setHint("Created", "ok");
    }catch(err){
      var local=petRecord("local-"+Date.now().toString(36),body.name,body.text,body.pet.palette,body.pet.motion,"custom");
      local.source="local";
      local.voice=firstTruthy(body.voice,local.voice);
      local.pet.scale=body.pet.scale;local.pet.sprite.image_data_url=state.imageDataUrl;local.rules=body.rules;
      saveLocalAgent(local);upsertPet(local);selectPet(local);setHint("Created locally", "ok");
    }
  }

  async function previewSelected(){
    if(!state.selected)return;
    setConsole("Previewing", state.selected.companion_name);
    try{
      var res=await fetch("/api/pets/preview",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({agent_id:state.selected.id,companion_id:state.selected.companion_id,pet:state.selected.pet,rules:readRules()})});
      var data=await res.json().catch(function(){return {};});
      if(!res.ok)throw new Error(firstTruthy(data.error,"Preview failed"));
      setConsole("Preview",firstTruthy(data.sample_text,state.selected.companion_name));
    }catch(err){
      setConsole("Preview",firstTruthy(state.selected.companion_summary,state.selected.companion_name));
    }
  }

  async function bookmarkSelected(){
    if(!state.selected)return;
    var fallbackUrl=agentUrl(state.selected.id);
    setConsole("Sharing", state.selected.companion_name);
    try{
      var res=await fetch("/api/pets/bookmarks",{
        method:"POST",
        headers:{"content-type":"application/json"},
        body:JSON.stringify({
          agent_id:state.selected.id,
          companion_id:state.selected.companion_id,
          pet:state.selected.pet,
          rules:readRules(),
          companion:{id:state.selected.companion_id,name:state.selected.companion_name,summary:state.selected.companion_summary}
        })
      });
      var data=await res.json().catch(function(){return {};});
      if(!res.ok)throw new Error(firstTruthy(data.error,"Bookmark failed"));
      var url=cleanBookmarkUrl(firstTruthy(data.url,fallbackUrl),state.selected.id);
      showShareUrl(url);
      setConsole("Bookmarked", url);
    }catch(err){
      showShareUrl(fallbackUrl);
      setConsole("Bookmark blocked",firstTruthy(err.message,"Gateway unavailable"));
    }
  }

  async function applySelected(){
    if(!state.selected)return false;
    setConsole("Applying", state.selected.companion_name);
    try{
      var res=await fetch("/api/pets/apply",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({agent_id:state.selected.id,companion_id:state.selected.companion_id,scope:"global",source:"website-pet-studio",rules:readRules()})});
      var data=await res.json().catch(function(){return {};});
      if(!res.ok)throw new Error(firstTruthy(data.error,"Apply failed"));
      setConsole("Applied",firstTruthy(data.profile&&data.profile.active_companion_name,state.selected.companion_name));
      return true;
    }catch(err){
      setConsole("Apply blocked",firstTruthy(err.message,"Gateway unavailable"));
      return false;
    }
  }

  async function generateImage(){
    setHint("Generating", "");
    var body=formBody();
    body.image_data_url=state.imageDataUrl;
    try{
      var res=await fetch("/api/pets/generate",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
      var data=await res.json().catch(function(){return {};});
      if(!res.ok)throw new Error(firstTruthy(data.error,"Generate failed"));
      if(data.images&&data.images[0]&&data.images[0].data_url){
        state.imageDataUrl=data.images[0].data_url;els.fileName.textContent="Generated image";applyPetVisual();setHint("Generated", "ok");
      }else{
        setHint(data.status==="not_configured"?"Generation not configured":"Generation planned", "");
      }
    }catch(err){
      setHint(firstTruthy(err.message,"Generate failed"), "err");
    }
  }

  // ---- Describe-it: one prompt -> draft manifest + sprite/plan + suggested
  // voice, in one pass. The manual controls on the right become refinement.

  async function describeCharacter(){
    var prompt=cleanText(els.describeInput.value,400);
    if(!prompt){
      setDescribeStatus("Describe a character first, e.g. \"a shy forest fox that guards my notes\".","err");
      els.describeInput.focus();
      return;
    }
    els.describeApplyBtn.disabled=true;
    setDescribeStatus("Making a character from your description…","");
    var draft=await deriveDraft(prompt);
    state.describedDraft=draft.record;
    state.describedServerBacked=draft.serverBacked;
    if(draft.serverBacked)upsertPet(draft.record);
    selectPet(draft.record);
    els.describeApplyBtn.disabled=false;
    setDescribeStatus("Drafted "+draft.record.companion_name+" — "+draft.record.pet.palette+" / "+draft.record.pet.motion+
      " / voice "+voiceBindingVoice(draft.record)+(draft.serverBacked?"":" (offline draft)")+". Generating a sprite…","");
    await runDescribeGeneration(prompt,draft.record);
  }

  // Prefer the gateway's server-side derivation (POST /v1/agent/pets {text}),
  // which returns a persisted draft manifest with a suggested voice. Fall back
  // to client keyword heuristics when the gateway route is unavailable.
  async function deriveDraft(prompt){
    try{
      var res=await fetch("/api/pets",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({text:prompt})});
      if(res.ok){
        var data=await res.json().catch(function(){return {};});
        if([data.pet,data.companion].some(Boolean)){
          var record=normalizePet(firstTruthy(data.pet,data.companion));
          if(!record.companion_summary)record.companion_summary=prompt;
          return {record:record,serverBacked:true};
        }
      }
    }catch(err){}
    return {record:buildDraftFromPrompt(prompt).record,serverBacked:false};
  }

  async function runDescribeGeneration(prompt,record){
    var name=record.companion_name;
    var body=formBody();
    body.text=prompt;
    body.image_data_url="";
    try{
      var res=await fetch("/api/pets/generate",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
      if([404,503,501].includes(res.status)){
        setDescribeStatus("Drafted "+name+" with a built-in sprite (gateway generation unavailable). Press Apply character to make it your companion.","plan");
        return;
      }
      var data=await res.json().catch(function(){return {};});
      if(!res.ok)throw new Error(firstTruthy(data.error,"Generate failed"));
      if(data.images&&data.images[0]&&data.images[0].data_url){
        state.imageDataUrl=data.images[0].data_url;
        els.fileName.textContent="Generated image";
        applyPetVisual();
        setDescribeStatus("Generated a sprite for "+name+". Press Apply character to make it your companion.","ok");
      }else if(data.status==="not_configured"){
        setDescribeStatus("Live sprite generation is off on the gateway — "+name+" uses the built-in sprite for now. The character plan is ready; press Apply character to make it your companion.","plan");
      }else{
        setDescribeStatus(name+" is drafted (sprite generation planned). Press Apply character to make it your companion.","plan");
      }
    }catch(err){
      setDescribeStatus("Drafted "+name+" ("+firstTruthy(err&&err.message,"generation unavailable")+"). Press Apply character to make it your companion.","plan");
    }
  }

  async function applyDescribedCharacter(){
    if(!state.describedDraft){
      setDescribeStatus("Describe a character and press Make it first.","err");
      return;
    }
    els.describeApplyBtn.disabled=true;
    // A server-backed draft is already a persisted companion — apply it directly.
    // A client-only (offline) draft needs a create pass first.
    if(!state.describedServerBacked){
      setDescribeStatus("Creating "+firstTruthy(els.petName.value.trim(),"the character")+"…","");
      await createPet({preventDefault:function(){}});
    }
    setDescribeStatus("Applying "+firstTruthy(state.selected&&state.selected.companion_name,"character")+" as your companion…","");
    var applied=await applySelected();
    var name=firstTruthy(state.selected&&state.selected.companion_name,"Your character");
    if(applied){
      setDescribeStatus(name+" is now your companion. Refine it in the panels on the right, then Apply again to update.","ok");
    }else{
      setDescribeStatus(name+" is drafted, but applying it needs the gateway (see the console). Refine it in the panels, then Apply again.","plan");
    }
    els.describeApplyBtn.disabled=false;
  }

  function buildDraftFromPrompt(prompt){
    var lower=prompt.toLowerCase();
    var palette=matchHint(lower,PALETTE_HINTS,"blue");
    var motion=matchHint(lower,MOTION_HINTS,"walk");
    var voice=matchHint(lower,VOICE_HINTS,"Kore");
    var name=deriveName(prompt);
    var record=petRecord("draft-"+Date.now().toString(36),name,prompt,palette,motion,"custom");
    record.source="draft";
    record.companion_summary=prompt;
    record.voice=voice;
    return {record:record,name:name,palette:palette,motion:motion,voice:voice};
  }

  function matchHint(text,table,fallback){
    for(var i=0;i<table.length;i++){if(table[i].re.test(text))return table[i].value;}
    return fallback;
  }

  function deriveName(prompt){
    var named=prompt.match(/\b(?:named|called)\s+([A-Za-z][\w'-]*(?:\s+[A-Za-z][\w'-]*)?)/);
    if(named&&named[1]){
      var picked=cleanText(named[1],40).split(/\s+/).filter(function(word){
        return NAME_STOPWORDS.indexOf(word.toLowerCase())<0;
      });
      if(picked.length)return titleCase(picked.join(" "));
    }
    var lead=prompt.replace(/^\s*(?:make|create|build|design|give)\s+(?:me\s+)?(?:an?|the)?\s*/i,"");
    var words=cleanText(lead,80).split(/\s+/).filter(function(word){
      return word.length>1&&NAME_STOPWORDS.indexOf(word.toLowerCase())<0;
    });
    return firstTruthy(titleCase(words.slice(0,2).join(" ")),"Shigmi Companion");
  }

  function titleCase(value){
    return String(firstTruthy(value,"")).toLowerCase().replace(/\b[a-z]/g,function(c){return c.toUpperCase();}).trim();
  }

  function setDescribeStatus(text,kind){
    els.describeStatus.textContent=text;
    els.describeStatus.className="describe-status "+firstTruthy(kind,"");
  }

  // ---- Shared library: browse + install + publish. Feature-detected on 404 so
  // the site is safe to ship before or after the gateway library routes land.

  function ownsSelected(){
    var selected=state.selected;
    if(!selected)return false;
    var source=String(firstTruthy(selected.source,"custom")).toLowerCase();
    return ["local","draft","custom","user"].includes(source);
  }

  function updatePublishVisibility(){
    els.publishBtn.classList.toggle("hidden",!(features.publish&&ownsSelected()));
  }

  function hideLibrary(){
    features.sharedLibrary=false;
    features.publish=false;
    els.library.classList.add("hidden");
    updatePublishVisibility();
  }

  async function loadSharedLibrary(){
    try{
      var res=await fetch("/api/pets/shared",{headers:{"accept":"application/json"}});
      if([404,503,501].includes(res.status)){hideLibrary();return;}
      if(!res.ok)throw new Error("HTTP "+res.status);
      var data=await res.json().catch(function(){return {};});
      var raw=firstTruthy(data.pets,data.shared,data.items,data.library,data.characters,[]);
      sharedItems=(Array.isArray(raw)?raw:[]).map(normalizePet);
      features.sharedLibrary=true;
      features.publish=true;
      els.library.classList.remove("hidden");
      renderLibrary(sharedItems);
      updatePublishVisibility();
    }catch(err){
      hideLibrary();
    }
  }

  function renderLibrary(items){
    els.libraryList.innerHTML="";
    var list=firstTruthy(items,[]).slice(0,40);
    els.libraryStatus.textContent=String(list.length);
    els.libraryEmpty.hidden=list.length>0;
    list.forEach(function(item){
      var row=document.createElement("div");
      row.className="lib-row";
      row.dataset.sharedId=firstTruthy(item.id,item.companion_id,"");
      row.innerHTML='<span class="mini"><span class="mini-dot"></span></span>'+
        '<span class="lib-copy"><strong></strong><span></span></span>'+
        '<button class="lib-install" type="button">Install</button>';
      row.querySelector("strong").textContent=firstTruthy(item.companion_name,"Shared character");
      row.querySelector(".lib-copy span").textContent=firstTruthy(item.pet.motion,"walk")+" / voice "+voiceBindingVoice(item);
      row.querySelector(".mini-dot").style.background=firstTruthy(palettes[item.pet.palette],palettes.blue);
      els.libraryList.appendChild(row);
    });
  }

  function onLibraryClick(event){
    var row=event.target.closest(".lib-row");
    if(!row)return;
    var id=row.dataset.sharedId;
    var item=sharedItems.filter(function(entry){return firstTruthy(entry.id,entry.companion_id)===id;})[0];
    if(!item)return;
    if(event.target.closest(".lib-install")){installShared(item,row);return;}
    // Row click previews the shared character in the stage without installing.
    selectPet(item);
  }

  async function installShared(item,row){
    var button=row&&row.querySelector(".lib-install");
    if(button)button.disabled=true;
    setConsole("Installing",item.companion_name);
    try{
      var res=await fetch("/api/pets/install",{method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({id:firstTruthy(item.id,item.companion_id),companion_id:item.companion_id,scope:"global",source:"website-pet-studio"})});
      var data=await res.json().catch(function(){return {};});
      if(!res.ok)throw new Error(firstTruthy(data.error,"Install failed ("+res.status+")"));
      var pet=normalizePet(firstTruthy(data.pet,data.agent,data.companion,item));
      upsertPet(pet);
      selectPet(pet);
      setConsole("Installed",firstTruthy(data.profile&&data.profile.active_companion_name,pet.companion_name));
    }catch(err){
      setConsole("Install blocked",firstTruthy(err&&err.message,"Gateway unavailable"));
    }finally{
      if(button)button.disabled=false;
    }
  }

  async function publishSelected(){
    if(!state.selected)return;
    var id=firstTruthy(state.selected.id,state.selected.companion_id);
    if(!id){setConsole("Publish blocked","This character isn't saved yet — press Create agent first");return;}
    setConsole("Publishing",state.selected.companion_name);
    try{
      // Per-pet publish: POST /v1/agent/pets/:id/publish, empty body.
      var res=await fetch("/api/pets/"+encodeURIComponent(id)+"/publish",{method:"POST",
        headers:{"content-type":"application/json"},body:"{}"});
      if(res.status===501){
        features.publish=false;updatePublishVisibility();
        setConsole("Publish unavailable","This gateway does not offer publishing yet");
        return;
      }
      var data=await res.json().catch(function(){return {};});
      if(res.status===409){
        // Consent/provenance review not approved, or a built-in that can't be
        // published — a normal state, shown plainly, not an error toast.
        setConsole("Publish pending review",publishBlockMessage(data));
        return;
      }
      if(res.status===404){
        // The library routes exist (features.publish came from /shared), so a
        // 404 here means this character is not saved on the gateway yet.
        setConsole("Publish blocked","This character isn't saved on the gateway yet — press Create agent first");
        return;
      }
      if(!res.ok)throw new Error(firstTruthy(data.error,"Publish failed ("+res.status+")"));
      setConsole("Published",state.selected.companion_name+" is now in the shared library");
      loadSharedLibrary();
    }catch(err){
      setConsole("Publish blocked",firstTruthy(err&&err.message,"Gateway unavailable"));
    }
  }

  function publishBlockMessage(data){
    var code=String(firstTruthy(data&&data.code,"")).toLowerCase();
    if(code==="not_publishable")
      return "Built-in characters can't be published. Make your own with Describe or Create agent.";
    var reason=String(firstTruthy(data&&data.reason,"")).toLowerCase();
    if(reason==="rejected")
      return "This character's provenance review was rejected, so it can't be shared.";
    return firstTruthy(data&&data.error,"This character needs consent and provenance review before it can be shared.");
  }

  function formBody(){
    state.scale=firstTruthy(Number(els.scaleInput.value),1);
    var rules=readRules();
    return {
      name:firstTruthy(els.petName.value.trim(),"Shigmi Companion"),
      text:els.petPrompt.value.trim(),
      palette:state.palette,
      motion:state.motion,
      voice:state.voice,
      image_data_url:state.imageDataUrl,
      rules:rules,
      companion:{name:firstTruthy(els.petName.value.trim(),"Shigmi Companion"),summary:els.petPrompt.value.trim(),voice:state.voice},
      pet:{palette:state.palette,motion:state.motion,scale:state.scale,source_image:state.imageDataUrl}
    };
  }

  function handleImageUpload(){
    var file=els.imageInput.files&&els.imageInput.files[0];
    if(!file)return;
    if(file.size>520000){setHint("Image is too large", "err");return;}
    var reader=new FileReader();
    reader.onload=function(){
      state.imageDataUrl=String(firstTruthy(reader.result,""));
      els.fileName.textContent=file.name;
      applyPetVisual();
      setHint("Image loaded", "ok");
    };
    reader.onerror=function(){setHint("Image failed", "err");};
    reader.readAsDataURL(file);
  }

  // One pointer gesture, two meanings: hold still ~260ms = talk to the pet
  // (release to send), move first = drag it around. Same split as the
  // extension launcher's voice-first gestures.
  function startDrag(event){
    state.pointerStart={x:event.clientX,y:event.clientY};
    els.pet.setPointerCapture(event.pointerId);
    if(voice.state==="idle"){
      state.holdTimer=setTimeout(function(){
        state.holdTimer=null;
        state.holdTalk=true;
        startTalk();
      },260);
    }
  }
  function dragMove(event){
    if(state.holdTalk)return;
    if(state.pointerStart&&!state.drag){
      var dx=event.clientX-state.pointerStart.x,dy=event.clientY-state.pointerStart.y;
      if(Math.sqrt(dx*dx+dy*dy)>8){
        clearHoldTimer();
        state.drag=true;els.pet.classList.add("dragging");
      }
    }
    if(!state.drag)return;moveToPointer(event);
  }
  function endDrag(){
    clearHoldTimer();
    if(state.holdTalk){
      state.holdTalk=false;state.pointerStart=null;
      if(voice.state==="listening")stopTalk();
      return;
    }
    state.pointerStart=null;
    if(!state.drag)return;
    state.drag=false;els.pet.classList.remove("dragging");state.mode=motionMode(state.motion);applyPetVisual();
  }
  function clearHoldTimer(){
    if(state.holdTimer){clearTimeout(state.holdTimer);state.holdTimer=null;}
  }

  // ---- Voice agent: mic -> /api/voice/session-ticket -> wss voice session ->
  // streamed pcm16 reply audio. The pet's selected voice rides on session_start
  // as a per-session override; replies play through Web Audio only (no local
  // speech synthesis — a text reply stays text).

  function toggleTalk(){
    if(voice.state==="idle"){startTalk();}
    else if(voice.state==="listening"){stopTalk();}
    else{cancelVoiceTurn();}
  }

  async function startTalk(){
    if(voice.state!=="idle")return;
    stopPlayback();
    renderTurns();
    voice.turnId="turn_"+Math.random().toString(36).slice(2,14);
    voice.pending=[];voice.commitQueued=false;voice.replyText="";
    voice.audioDone=false;voice.gotReplyAudio=false;voice.turnDone=false;voice.playHead=0;
    voice.playbackRate=1;
    setVoiceState("listening");
    setConsole("Listening","Speak, then release the pet or press Send");
    try{
      await startCapture();
      var res=await fetch("/api/voice/session-ticket",{
        method:"POST",
        headers:{"content-type":"application/json"},
        body:JSON.stringify({session_id:voiceSessionId(),device_id:voiceDeviceId()})
      });
      var ticket=await res.json().catch(function(){return {};});
      if(!res.ok||!ticket.ws_url)throw new Error(firstTruthy(ticket.error,"Voice ticket failed"));
      if(voice.state==="idle")return;
      openVoiceSocket(ticket.ws_url);
    }catch(err){
      teardownVoice(true);
      setConsole("Voice blocked",firstTruthy(err&&err.message,"Microphone or gateway unavailable"));
    }
  }

  function openVoiceSocket(url){
    var ws=new WebSocket(url);
    ws.binaryType="arraybuffer";
    voice.ws=ws;
    ws.onopen=function(){
      if(voice.ws!==ws)return;
      if(voice.state==="idle"){try{ws.close();}catch(e){}return;}
      ws.send(JSON.stringify({
        type:"session_start",
        session_id:voiceSessionId(),
        conversation_id:voiceSessionId(),
        turn_id:voice.turnId,
        device_id:voiceDeviceId(),
        source:"website-pet-studio",
        voice:state.voice,
        persona:petPersona(),
        format:{encoding:"pcm16",sample_rate:16000,channels:1},
        client:{surface:"website-pet-studio",pet_id:firstTruthy(state.selected&&state.selected.id,"")}
      }));
      flushPendingAudio();
      if(voice.commitQueued){voice.commitQueued=false;commitVoiceTurn();}
    };
    ws.onmessage=function(event){
      if(voice.ws!==ws)return;
      if(typeof event.data==="string"){
        var payload=null;
        try{payload=JSON.parse(event.data);}catch(err){return;}
        handleVoiceEvent(payload);
      }else{
        voice.gotReplyAudio=true;
        playPcmChunk(event.data);
      }
    };
    ws.onclose=function(){
      if(voice.ws!==ws)return;
      voice.ws=null;
      if(["listening","thinking"].includes(voice.state)){
        teardownVoice(false);
        setConsole("Voice disconnected","Try again");
      }
    };
  }

  function stopTalk(){
    if(voice.state!=="listening")return;
    stopCapture();
    setVoiceState("thinking");
    setConsole("Thinking","");
    if(voice.ws&&voice.ws.readyState===1){commitVoiceTurn();}
    else{voice.commitQueued=true;}
  }

  function commitVoiceTurn(){
    try{voice.ws.send(JSON.stringify({type:"commit_turn",turn_id:voice.turnId}));}catch(err){}
  }

  function cancelVoiceTurn(){
    if(voice.ws&&voice.ws.readyState===1){
      try{voice.ws.send(JSON.stringify({type:"cancel_turn",turn_id:voice.turnId}));}catch(err){}
    }
    teardownVoice(true);
    setConsole("Canceled","Hold the pet or press Talk to speak with it");
  }

  function handleVoiceEvent(event){
    if(!event||typeof event!=="object")return;
    if(event.type==="turn_progress"){
      if(voice.state==="thinking")setConsole("Thinking",event.stage==="tts"?"Finding its voice":"Reasoning");
    }else if(["transcript_partial","transcript_final"].includes(event.type)){
      setConsole("You",firstTruthy(event.text,""));
    }else if(event.type==="assistant_text"){
      voice.replyText=firstTruthy(event.text,"");
      setConsole(petDisplayName(),voice.replyText);
    }else if(event.type==="assistant_audio_start"){
      var rate=Number(event.playback_rate);
      voice.playbackRate=(isFinite(rate)&&rate>0)?rate:1;
      setVoiceState("speaking");
      if(voice.replyText)setConsole(petDisplayName(),voice.replyText);
    }else if(event.type==="assistant_audio_done"){
      voice.audioDone=true;
      scheduleVoiceFinish();
    }else if(event.type==="turn_done"){
      voice.turnDone=true;
      handleVoiceTurnDone(event);
    }else if(event.type==="error"){
      teardownVoice(true);
      setConsole("Voice error",firstTruthy(event.message,""));
    }
  }

  function handleVoiceTurnDone(event){
    var status=String(firstTruthy(event.status,"completed"));
    if(status==="no_speech"){
      teardownVoice(true);
      setConsole("Didn't catch that","Hold the pet, speak, then release");
      return;
    }
    if(status!=="completed"){
      teardownVoice(true);
      setConsole("Voice "+status,firstTruthy(event.reason,""));
      return;
    }
    if(!voice.gotReplyAudio){
      // Deliberate text delivery (modality text / no hosted voice for the
      // language): the reply stays on screen, nothing speaks locally.
      var line=voice.replyText;
      teardownVoice(true);
      if(line)setConsole(petDisplayName()+" (text)",line);
      return;
    }
    voice.audioDone=true;
    scheduleVoiceFinish();
  }

  function scheduleVoiceFinish(){
    if(!voice.audioDone)return;
    if(!voice.ctx){teardownVoice(true);return;}
    var remainingMs=Math.max(0,(voice.playHead-voice.ctx.currentTime)*1000)+150;
    if(voice.finishTimer)clearTimeout(voice.finishTimer);
    voice.finishTimer=setTimeout(function(){
      voice.finishTimer=null;
      var line=voice.replyText;
      teardownVoice(true);
      if(line)setConsole(petDisplayName(),line);
    },remainingMs);
  }

  async function startCapture(){
    voice.ctx=new (firstTruthy(window.AudioContext,window.webkitAudioContext))();
    if(voice.ctx.state==="suspended")await voice.ctx.resume();
    voice.mediaStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true}});
    voice.sourceNode=voice.ctx.createMediaStreamSource(voice.mediaStream);
    voice.processor=voice.ctx.createScriptProcessor(4096,1,1);
    voice.processor.onaudioprocess=function(event){
      if(voice.state!=="listening")return;
      var pcm=downsamplePcm16(event.inputBuffer.getChannelData(0),voice.ctx.sampleRate,16000);
      if(!pcm)return;
      if(voice.ws&&voice.ws.readyState===1){try{voice.ws.send(pcm);}catch(err){}}
      else if(voice.pending.length<64){voice.pending.push(pcm);}
    };
    voice.sourceNode.connect(voice.processor);
    voice.processor.connect(voice.ctx.destination);
  }

  function stopCapture(){
    if(voice.processor){try{voice.processor.disconnect();}catch(err){}voice.processor.onaudioprocess=null;voice.processor=null;}
    if(voice.sourceNode){try{voice.sourceNode.disconnect();}catch(err){}voice.sourceNode=null;}
    if(voice.mediaStream){voice.mediaStream.getTracks().forEach(function(track){track.stop();});voice.mediaStream=null;}
  }

  function flushPendingAudio(){
    if(!voice.ws||voice.ws.readyState!==1)return;
    var chunks=voice.pending;
    voice.pending=[];
    chunks.forEach(function(chunk){try{voice.ws.send(chunk);}catch(err){}});
  }

  // Assistant audio is pcm16 mono @16k; schedule chunks back to back so the
  // streamed reply plays gaplessly as frames arrive.
  function playPcmChunk(arrayBuffer){
    if(!voice.ctx||!arrayBuffer)return;
    var byteLength=arrayBuffer.byteLength-(arrayBuffer.byteLength%2);
    if(byteLength<=0)return;
    var ints=new Int16Array(arrayBuffer,0,byteLength/2);
    var floats=new Float32Array(ints.length);
    for(var i=0;i<ints.length;i++)floats[i]=ints[i]/32768;
    var buffer=voice.ctx.createBuffer(1,floats.length,16000);
    buffer.getChannelData(0).set(floats);
    var source=voice.ctx.createBufferSource();
    source.buffer=buffer;
    var rate=firstTruthy(voice.playbackRate,1);
    source.playbackRate.value=rate;
    source.connect(voice.ctx.destination);
    var at=Math.max(voice.ctx.currentTime+0.05,firstTruthy(voice.playHead,0));
    source.start(at);
    voice.playHead=at+buffer.duration/rate;
  }

  function downsamplePcm16(floats,fromRate,toRate){
    if(!floats||!floats.length)return null;
    var ratio=fromRate/toRate;
    if(!(ratio>=1))ratio=1;
    var outLength=Math.floor(floats.length/ratio);
    if(outLength<=0)return null;
    var out=new Int16Array(outLength);
    var pos=0;
    for(var i=0;i<outLength;i++){
      var next=Math.min(floats.length,Math.floor((i+1)*ratio));
      var sum=0,count=0;
      for(var j=pos;j<next;j++){sum+=floats[j];count++;}
      var sample=count?sum/count:0;
      sample=Math.max(-1,Math.min(1,sample));
      out[i]=sample<0?sample*0x8000:sample*0x7fff;
      pos=next;
    }
    return out.buffer;
  }

  function teardownVoice(closeWs){
    var completedTurn=voice.turnDone;
    stopCapture();
    if(voice.finishTimer){clearTimeout(voice.finishTimer);voice.finishTimer=null;}
    if(closeWs&&voice.ws){try{voice.ws.close();}catch(err){}}
    voice.ws=null;
    if(voice.ctx){try{voice.ctx.close();}catch(err){}voice.ctx=null;}
    voice.pending=[];voice.commitQueued=false;
    voice.playHead=0;voice.audioDone=false;voice.gotReplyAudio=false;voice.turnDone=false;
    setVoiceState("idle");
    // The finished turn is durable on the gateway a beat after turn_done;
    // pull it into the conversation tape.
    if(completedTurn)refreshTurnsSoon();
  }

  function setVoiceState(next){
    voice.state=next;
    els.talkBtn.className="talk-btn"+(next==="idle"?"":" "+next);
    els.talkBtn.textContent=next==="idle"?"Talk":next==="listening"?"Send":next==="thinking"?"...":"Stop";
    if(next==="listening"){state.mode="wave";}
    else if(next==="thinking"){state.mode="float";}
    else if(next==="speaking"){state.mode="tap";}
    else{state.mode=motionMode(state.motion);state.nextModeAt=0;}
    applyPetVisual();
  }

  function petDisplayName(){
    return firstTruthy(state.selected&&state.selected.companion_name,"Pet");
  }

  // The pet speaks AS itself: its name and prompt ride session_start as a
  // session-scoped persona (the gateway sanitizes and caps it; nothing is
  // written to the stored profile).
  function petPersona(){
    var name=cleanText(state.selected&&state.selected.companion_name,80);
    var text=cleanText(state.selected&&state.selected.companion_summary,400);
    if(!name&&!text)return undefined;
    return {name:name,text:text};
  }

  function voiceSessionId(){
    var petId=String(firstTruthy(state.selected&&state.selected.id,"studio")).replace(/[^a-zA-Z0-9_-]/g,"_").slice(0,80);
    return "petweb_"+petId;
  }

  function voiceDeviceId(){
    try{
      var existing=window.localStorage.getItem(deviceIdKey);
      if(existing)return existing;
      var next="petweb_"+Math.random().toString(36).slice(2,12);
      window.localStorage.setItem(deviceIdKey,next);
      return next;
    }catch(err){
      return "petweb_anon";
    }
  }
  function moveToPointer(event){
    var rect=els.stage.getBoundingClientRect();
    state.x=event.clientX-rect.left-48;state.y=event.clientY-rect.top-48;
    clampPosition();positionPet();
  }

  function tick(time){
    var rect=els.stage.getBoundingClientRect();
    if(!state.last)state.last=time;
    var dt=Math.min((time-state.last)/1000,.04);state.last=time;
    if(!state.drag&&voice.state==="idle"&&rect.width>0&&rect.height>0){
      if(time>state.nextModeAt){
        state.mode=randomMode();
        state.nextModeAt=time+1800+Math.random()*2600;
        applyPetVisual();
      }
      var floorY=Math.max(40,rect.height-154);
      if(state.mode==="walk"){
        state.x+=state.vx*state.dir*dt;
        state.y+=(floorY-state.y)*Math.min(1,dt*8);
      }else if(state.mode==="climb"){
        state.y-=38*dt;
        if(state.y<18){state.mode="fall";applyPetVisual();}
      }else if(state.mode==="fall"){
        state.y+=220*dt;
        if(state.y>floorY){state.y=floorY;state.mode="walk";applyPetVisual();}
      }else if(["float","idle","wave"].includes(state.mode)){
        state.y+=(floorY-state.y)*Math.min(1,dt*2);
      }
      if(state.x<10){state.x=10;state.dir=1}
      if(state.x>rect.width-106){state.x=rect.width-106;state.dir=-1}
      clampPosition();positionPet();
    }
    requestAnimationFrame(tick);
  }

  function randomMode(){
    if(["climb","peek"].includes(state.motion))return Math.random()<.38?"climb":"walk";
    if(["float","trail"].includes(state.motion))return Math.random()<.5?"float":"walk";
    if(["spark","tap"].includes(state.motion))return Math.random()<.42?"wave":"tap";
    return Math.random()<.22?"idle":"walk";
  }
  function motionMode(motion){
    if(["float","trail"].includes(motion))return "float";
    if(["tap","spark"].includes(motion))return "tap";
    if(["climb","peek"].includes(motion))return "climb";
    return "walk";
  }
  function clampPosition(){
    var rect=els.stage.getBoundingClientRect();
    state.x=Math.max(8,Math.min(state.x,Math.max(8,rect.width-104)));
    state.y=Math.max(8,Math.min(state.y,Math.max(8,rect.height-104)));
  }
  function positionPet(){
    els.pet.style.transform="translate("+state.x+"px,"+state.y+"px) scaleX("+state.dir+") scale("+state.scale+")";
  }
  function setHint(text,kind){els.hint.textContent=text;els.hint.className="hint "+firstTruthy(kind,"");}
  function setConsole(title,line){els.consoleTitle.textContent=title;els.consoleLine.textContent=firstTruthy(line,"");}

  return {
    state:state, voice:voice, features:features, player:player, elements:els,
    petRecord:petRecord, normalizePet:normalizePet, mergePets:mergePets,
    findPet:findPet, getLocalAgents:getLocalAgents, findLocalAgent:findLocalAgent,
    saveLocalAgent:saveLocalAgent, sanitizeRules:sanitizeRules, cleanText:cleanText,
    agentUrl:agentUrl, cleanBookmarkUrl:cleanBookmarkUrl, canonicalVoiceId:canonicalVoiceId,
    voiceBinding:voiceBinding, voiceBindingVoice:voiceBindingVoice,
    customVoiceState:customVoiceState, cloneJobStatus:cloneJobStatus,
    voiceReadiness:voiceReadiness, voiceDescription:voiceDescription,
    turnsSessionId:turnsSessionId, findTurn:findTurn, formatTurnTime:formatTurnTime,
    playKey:playKey, publishBlockMessage:publishBlockMessage, formBody:formBody,
    buildDraftFromPrompt:buildDraftFromPrompt, matchHint:matchHint,
    deriveName:deriveName, titleCase:titleCase, ownsSelected:ownsSelected,
    downsamplePcm16:downsamplePcm16, petDisplayName:petDisplayName,
    petPersona:petPersona, voiceSessionId:voiceSessionId, voiceDeviceId:voiceDeviceId,
    randomMode:randomMode, motionMode:motionMode, selectPet:selectPet,
    chooseVoice:chooseVoice, renderTurns:renderTurns, renderCatalog:renderCatalog,
    handleVoiceEvent:handleVoiceEvent, handleVoiceTurnDone:handleVoiceTurnDone,
    playPcmChunk:playPcmChunk, flushPendingAudio:flushPendingAudio,
    setVoiceState:setVoiceState, setView:setView, loadPets:loadPets,
    loadVoiceOptions:loadVoiceOptions, loadActiveAgent:loadActiveAgent,
    loadAgent:loadAgent, findLocalAgent:findLocalAgent, saveLocalAgent:saveLocalAgent,
    loadTurns:loadTurns, loadSharedLibrary:loadSharedLibrary,
    generateImage:generateImage, describeCharacter:describeCharacter,
    deriveDraft:deriveDraft, runDescribeGeneration:runDescribeGeneration,
    applyDescribedCharacter:applyDescribedCharacter, publishSelected:publishSelected,
    installShared:installShared, makeDefaultVoice:makeDefaultVoice,
    startPcmPlayback:startPcmPlayback, playTurnAudio:playTurnAudio,
    updateRulesFromDom:updateRulesFromDom, refreshTurnsSoon:refreshTurnsSoon,
    onLibraryClick:onLibraryClick, handleImageUpload:handleImageUpload,
    startDrag:startDrag, dragMove:dragMove, endDrag:endDrag, clearHoldTimer:clearHoldTimer,
    toggleTalk:toggleTalk, openVoiceSocket:openVoiceSocket,
    commitVoiceTurn:commitVoiceTurn, scheduleVoiceFinish:scheduleVoiceFinish,
    startCapture:startCapture, moveToPointer:moveToPointer, tick:tick,
    clampPosition:clampPosition, positionPet:positionPet,
    startTalk:startTalk, stopTalk:stopTalk, cancelVoiceTurn:cancelVoiceTurn,
    teardownVoice:teardownVoice, stopPlayback:stopPlayback,
    refreshControlState:refreshControlState, applyPetVisual:applyPetVisual
  };
}

if(typeof window!=="undefined"&&typeof document!=="undefined"){
  createPetStudio(window,document);
}
