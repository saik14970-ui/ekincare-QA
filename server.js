'use strict';
// Local / office-PC launcher. For Vercel, api/index.js is used instead.
const http=require('http');
const {handle,eod,istDay,log}=require('./lib/app.js');
const PORT=+process.env.PORT||3000;
http.createServer(handle).listen(PORT,()=>console.log('ekincare AI Auditor running on port '+PORT));
setInterval(()=>{const t=new Date(Date.now()+5.5*3600e3),m=t.getUTCHours()*60+t.getUTCMinutes();if(m>=1320&&m<1380)eod(istDay(Date.now())).catch(x=>log('system','eod-error',x.message))},60e3);
