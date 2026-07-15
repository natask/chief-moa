export const MoaSlides = (function (scope) {
  var bird = '<svg class="bird-eyebrow" viewBox="0 0 50 50" aria-hidden="true"><use href="#moa-bird"/></svg>';

  var DECK = [
    { type: 'title', eyebrow: 'Moa', h: 'Map all the work you<br>do in <em>the browser.</em>', sub: 'Moa runs it as agents you watch and steer.' },
    { type: 'morph', aPre: 'We open fifty', from: 'tabs.', bPre: 'Soon we run fifty', to: 'agents.', sub: 'People already work this way. <span class="dim">The tools do not exist yet.</span>' },
    { type: 'statement', size: 'xl', h: '<em>Agent sprawl.</em>', sub: 'Launch a second agent and you lose the first. <span class="dim">No map. No memory.</span>' },
    { type: 'flow', size: 'md', h: 'What does <span class="ital">one</span> agent do?', inLabel: 'in', inItems: 'text · image<br>audio · video', outLabel: 'out', outItems: 'text · image<br>audio · video', caption: 'It takes what you give it, does the work in a tab, and hands back the result.' },
    { type: 'beats', size: 'lg', h: 'Every agent is one<br><em>thread of work.</em>', items: [
      'Moa keeps the <em>map</em>. You see every thread at once.',
      'Speak again and it updates the <em>right thread</em>. <span class="dim">No sessions to manage.</span>',
      'Change your mind and the <em>latest word wins</em>. <span class="dim">You keep your place.</span>',
    ] },
    { type: 'statement', size: 'lg', h: 'You steer it<br>by <em>talking.</em>', sub: 'Each agent works in its own background tab in your browser. It <span class="tag">pings</span> you when it needs a choice.', wide: true },
    { type: 'proof', size: 'lg', h: 'It <em>already</em> runs.', pipe: 'speak <b>&rarr;</b> build context <b>&rarr;</b> work in a tab <b>&rarr;</b> <b>ping</b>', chips: [{ t: 'gateway · 10.147.17.10 · 200', on: true }, { t: 'voice round-trip ✓' }, { t: 'prompt history ✓' }] },
    { type: 'grid', eyebrow: 'What you get', size: 'md', h: 'You <span class="ital">own</span> it.', cells: [
      { h: 'Self-hosted', p: 'Run it on your own machine. Your keys, your data.' },
      { h: 'Yours to change', p: 'Ask for a change and a new version ships. We keep it running.' },
      { h: 'Every device', p: 'One agent across desktop, browser, and phone.' },
      { h: 'Any model', p: 'Swap the model under it. Your work stays.' },
    ] },
    { type: 'bio', eyebrow: 'Who is building it', photo: '/assets/nat.png', name: 'Natnael Kahssay', role: 'Founder · EECS @ MIT · Y Combinator', sub: 'EECS at MIT. Left to build <em>Code Four</em> (YC&nbsp;X25). Building Moa next.', creds: [
      { src: '/assets/mit-logo.svg', label: 'MIT' },
      { src: '/assets/yc-logo.svg', label: 'Y Combinator' },
      { src: '/assets/codefour-logo.png', label: 'Code Four · YC X25', box: true },
    ] },
    { type: 'morph', aPre: 'We used to manage', from: 'tabs.', bPre: 'Now Moa maps the', to: 'work.' },
  ];

  var renderers = {
    title: function (slide) { return '<section data-auto-animate><p class="eyebrow">' + bird + ' ' + slide.eyebrow + '</p><h1 class="' + (slide.size || 'xl') + '" data-id="spine">' + slide.h + '</h1>' + (slide.sub ? '<p class="sub">' + slide.sub + '</p>' : '') + '</section>'; },
    statement: function (slide) { return '<section data-auto-animate><h1 class="' + slide.size + '" data-id="spine">' + slide.h + '</h1>' + (slide.sub ? '<p class="sub' + (slide.wide ? ' wide' : '') + '">' + slide.sub + '</p>' : '') + '</section>'; },
    flow: function (slide) { return '<section data-auto-animate><h1 class="' + slide.size + '" data-id="spine">' + slide.h + '</h1><div class="flow"><div class="node io"><h4>' + slide.inLabel + '</h4><small>' + slide.inItems + '</small></div><div class="node loop"><span>↻</span></div><div class="node io"><h4>' + slide.outLabel + '</h4><small>' + slide.outItems + '</small></div></div><p class="sub wide">' + slide.caption + '</p></section>'; },
    beats: function (slide) { return '<section data-auto-animate><h1 class="' + slide.size + '" data-id="spine">' + slide.h + '</h1><ul class="beats">' + slide.items.map(function (item) { return '<li>' + item + '</li>'; }).join('') + '</ul></section>'; },
    proof: function (slide) { return '<section data-auto-animate><h1 class="' + slide.size + '" data-id="spine">' + slide.h + '</h1><p class="pipe">' + slide.pipe + '</p><div class="chips">' + slide.chips.map(function (chip) { return '<span class="chip' + (chip.on ? ' on' : '') + '">' + chip.t + '</span>'; }).join('') + '</div></section>'; },
    grid: function (slide) { return '<section data-auto-animate><p class="eyebrow">' + slide.eyebrow + '</p><h1 class="' + slide.size + '" data-id="spine">' + slide.h + '</h1><div class="grid">' + slide.cells.map(function (cell) { return '<div class="cell"><h4>' + cell.h + '</h4><p>' + cell.p + '</p></div>'; }).join('') + '</div></section>'; },
    bio: function (slide) { return '<section data-auto-animate><p class="eyebrow">' + bird + ' ' + slide.eyebrow + '</p><div class="bio"><img class="bio-photo" src="' + slide.photo + '" alt="' + slide.name + '" /><div class="bio-body"><h1 class="md" data-id="spine">' + slide.name + '</h1><p class="bio-role">' + slide.role + '</p>' + (slide.sub ? '<p class="sub wide">' + slide.sub + '</p>' : '') + '<div class="creds">' + slide.creds.map(function (credential) { return '<span class="cred"><span class="mark' + (credential.box ? ' box' : '') + '"><img src="' + credential.src + '" alt="' + credential.label + '" /></span><small>' + credential.label + '</small></span>'; }).join('') + '</div></div></div></section>'; },
    morph: function (slide) { return '<section data-auto-animate><h1 class="' + (slide.size || 'xl') + '">' + slide.aPre + ' <span data-id="thing" class="ital">' + slide.from + '</span></h1></section><section data-auto-animate><h1 class="' + (slide.size || 'xl') + '">' + slide.bPre + ' <span data-id="thing"><em>' + slide.to + '</em></span></h1>' + (slide.sub ? '<p class="sub">' + slide.sub + '</p>' : '') + '</section>'; },
  };

  function renderDeck(deck, availableRenderers) {
    return deck.map(function (slide) { return availableRenderers[slide.type](slide); }).join('\n');
  }

  function formatCounter(index, total) {
    return String(index + 1).padStart(2, '0') + ' — ' + String(total).padStart(2, '0');
  }

  function init(document, reveal) {
    document.querySelector('.slides').innerHTML = renderDeck(DECK, renderers);
    reveal.initialize({
      width: 1280, height: 720, margin: 0.07,
      center: true, transition: 'fade', transitionSpeed: 'slow',
      controls: false, hash: true, progress: true,
      autoAnimateEasing: 'cubic-bezier(.16,.84,.34,1)', autoAnimateDuration: 0.7,
    });

    var counter = document.getElementById('counter');
    function setCounter() {
      counter.textContent = formatCounter(reveal.getIndices().h, reveal.getHorizontalSlides().length);
    }
    reveal.on('ready', setCounter);
    reveal.on('slidechanged', setCounter);
  }

  scope.MoaSlides = Object.freeze({ DECK: DECK, formatCounter: formatCounter, init: init, renderDeck: renderDeck, renderers: renderers });
  scope.MoaSlides.init(scope.document, scope.Reveal);
  return scope.MoaSlides;
}(globalThis));
