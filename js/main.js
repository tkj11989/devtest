(function(){
  var $=function(s,r){return (r||document).querySelector(s)},$$=function(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s))};
  var reduce=window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // nav + year
  var mb=$('#menuBtn'),menu=$('#menu');
  if(mb&&menu){
    mb.addEventListener('click',function(){var o=menu.classList.toggle('open');mb.setAttribute('aria-expanded',o)});
    $$('#menu a').forEach(function(a){a.addEventListener('click',function(){menu.classList.remove('open')})});
  }
  var y=$('#year');if(y)y.textContent=new Date().getFullYear();

  // live mini mock test
  var quiz=$('#quiz');
  if(quiz){
    var Q=[
      {q:'A train 120 m long crosses a pole in 6 seconds. What is its speed?',o:['18 km/h','54 km/h','72 km/h','90 km/h'],a:2,e:'120 m in 6 s is 20 m/s. Multiply by 3.6 to get 72 km/h.'},
      {q:'Find the odd one out: 16, 25, 36, 48, 64',o:['16','36','48','64'],a:2,e:'All others are perfect squares. 48 is not.'},
      {q:'Choose the correct word: She is senior ___ me.',o:['than','to','from','over'],a:1,e:'"Senior" takes "to", not "than". Same for junior, superior and inferior.'}
    ];
    var T=30,i=0,score=0,left=T,tick=null,done=false;
    var qt=$('#qText'),opts=$('#opts'),fb=$('#fb'),tm=$('#tm'),bar=$('#bar span'),nx=$('#next'),sc=$('#score'),num=$('#qnum'),body=$('#quizBody');
    function stop(){clearInterval(tick)}
    function render(){
      done=false;left=T;var d=Q[i];
      num.textContent='Question '+(i+1)+' of '+Q.length;
      qt.textContent=d.q;fb.innerHTML='Pick an answer before the timer runs out.';
      nx.hidden=true;opts.innerHTML='';
      d.o.forEach(function(t,k){
        var b=document.createElement('button');b.className='opt';b.type='button';
        b.innerHTML='<span class="bub">'+'ABCD'[k]+'</span><span></span>';b.lastChild.textContent=t;
        b.addEventListener('click',function(){answer(k)});opts.appendChild(b);
      });
      sc.textContent='Score '+score;timer();
    }
    function timer(){
      stop();paint();
      tick=setInterval(function(){left--;paint();if(left<=0){stop();answer(-1)}},1000);
    }
    function paint(){tm.textContent=left;bar.style.transform='scaleX('+(left/T)+')';bar.classList.toggle('low',left<=8)}
    function answer(k){
      if(done)return;done=true;stop();var d=Q[i],bs=$$('.opt',opts);
      bs.forEach(function(b){b.disabled=true});
      bs[d.a].classList.add('right');
      if(k===d.a){score++;fb.innerHTML='<strong>Correct.</strong> '+d.e}
      else{if(k>=0)bs[k].classList.add('wrong');fb.innerHTML='<strong>'+(k<0?'Time is up.':'Not quite.')+'</strong> '+d.e}
      sc.textContent='Score '+score;
      nx.textContent=i<Q.length-1?'Next question':'See result';nx.hidden=false;nx.focus();
    }
    nx.addEventListener('click',function(){
      if(i<Q.length-1){i++;render()}else{result()}
    });
    function result(){
      stop();
      body.innerHTML='<div class="result"><div class="num">'+score+'/'+Q.length+'</div><p>'+(score===Q.length?'Full marks. Ready for a real mock test?':'Practice makes the next score higher.')+'</p><a class="btn cobalt" href="https://examsuit.com" target="_blank" rel="noopener">Take a full mock test</a> <button class="btn" style="color:var(--cobalt)" id="again" type="button">Try again</button></div>';
      $('#again').addEventListener('click',function(){i=0;score=0;rebuild()});
    }
    var tpl=body.innerHTML;
    function rebuild(){
      body.innerHTML=tpl;
      qt=$('#qText');opts=$('#opts');fb=$('#fb');tm=$('#tm');bar=$('#bar span');nx=$('#next');sc=$('#score');num=$('#qnum');
      nx.addEventListener('click',function(){if(i<Q.length-1){i++;render()}else{result()}});
      render();
    }
    render();
  }

  // platform tabs
  var tabs=$$('.tab');
  function show(t){
    tabs.forEach(function(x){var on=x===t;x.setAttribute('aria-selected',on);x.tabIndex=on?0:-1;$('#'+x.getAttribute('aria-controls')).hidden=!on});
    var p=$('#'+t.getAttribute('aria-controls'));
    $$('.track',p).forEach(function(tr){var g=$('.g',tr),r=$('.r',tr);g.style.width='0';r.style.width='0';
      requestAnimationFrame(function(){requestAnimationFrame(function(){g.style.width=g.dataset.w+'%';r.style.width=r.dataset.w+'%'})})});
  }
  tabs.forEach(function(t,k){
    t.addEventListener('click',function(){show(t)});
    t.addEventListener('keydown',function(e){
      var n=e.key==='ArrowRight'?1:e.key==='ArrowLeft'?-1:0;if(!n)return;
      var nt=tabs[(k+n+tabs.length)%tabs.length];nt.focus();show(nt);
    });
  });
  if(tabs.length)show(tabs[0]);

  // question palette (sample)
  var pal=$('#pal');
  if(pal){
    var st='a a am na sk a m x a x na a am sk x a m x a x'.split(' ');
    st.forEach(function(s,k){var e=document.createElement('span');e.className=(s==='x'?'':s)+(k===3?' cur':'');e.textContent=k+1;pal.appendChild(e)});
  }

  // current-affairs week strip
  var wk=$('#week');
  if(wk){
    var names=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'],now=new Date();
    for(var d=-3;d<=3;d++){
      var dt=new Date(now.getFullYear(),now.getMonth(),now.getDate()+d),e=document.createElement('div');
      e.className='day'+(d===0?' today':d<0?' past':'');
      e.innerHTML=names[dt.getDay()]+'<b>'+dt.getDate()+'</b>'+(d===0?'Open':d<0?'Done':'Soon');
      wk.appendChild(e);
    }
  }

  // card tilt (pointer only, not for reduced motion)
  if(!reduce&&window.matchMedia('(hover:hover)').matches){
    $$('.app').forEach(function(c){
      c.addEventListener('pointermove',function(e){
        var r=c.getBoundingClientRect(),x=(e.clientX-r.left)/r.width-.5,y=(e.clientY-r.top)/r.height-.5;
        c.style.transform='perspective(900px) rotateY('+(x*7)+'deg) rotateX('+(-y*7)+'deg) translateY(-4px)';
      });
      c.addEventListener('pointerleave',function(){c.style.transform=''});
    });
  }
})();
