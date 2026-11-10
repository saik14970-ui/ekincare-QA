// Vercel serverless entry point
const {handle}=require('../lib/app.js');
module.exports=(req,res)=>handle(req,res);
