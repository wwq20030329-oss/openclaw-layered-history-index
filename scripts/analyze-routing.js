#!/usr/bin/env node
/**
 * 路由日志分析工具
 * 用法：node scripts/analyze-routing.js <path-to-route-trace.jsonl>
 */

const fs = require("node:fs");
const path = require("node:path");

function parseArgs() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("用法：node analyze-routing.js <route-trace.jsonl 文件路径>");
    console.error("示例：node scripts/analyze-routing.js ~/.openclaw/agents/main/agent/history/route-trace.jsonl");
    process.exit(1);
  }
  return args[0].replace(/^~/, process.env.HOME || "");
}

function readLines(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`错误：文件不存在 - ${filePath}`);
    process.exit(1);
  }
  const content = fs.readFileSync(filePath, "utf8");
  return content
    .split("\n")
    .filter(line => line.trim())
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function analyze(records) {
  const total = records.length;
  const withRoute = records.filter(r => r.route && typeof r.route === "object").length;
  const withoutRoute = total - withRoute;
  
  // 路由结果分析
  const routeDecisions = {
    needsL1: 0,
    needsL2: 0,
    noRecall: 0,
  };
  
  // 工具包使用统计
  const packUsage = {};
  
  // 文件使用统计
  const fileUsage = {};
  
  // 日期分布
  const dateUsage = {};
  
  // 路由原因关键词
  const reasonKeywords = {};
  
  for (const r of records) {
    if (!r.route) {
      routeDecisions.noRecall += 1;
      continue;
    }
    
    const route = r.route;
    if (route.needsL1) routeDecisions.needsL1 += 1;
    if (route.needsL2) routeDecisions.needsL2 += 1;
    
    if (Array.isArray(route.packs)) {
      for (const pack of route.packs) {
        packUsage[pack] = (packUsage[pack] || 0) + 1;
      }
    }
    
    if (Array.isArray(route.files)) {
      for (const file of route.files) {
        fileUsage[file] = (fileUsage[file] || 0) + 1;
      }
    }
    
    if (Array.isArray(route.l1Dates)) {
      for (const date of route.l1Dates) {
        dateUsage[date] = (dateUsage[date] || 0) + 1;
      }
    }
    
    if (route.reason) {
      const words = route.reason.split(/[\s,，.]+/).filter(w => w.length > 1);
      for (const word of words) {
        reasonKeywords[word] = (reasonKeywords[word] || 0) + 1;
      }
    }
  }
  
  return {
    total,
    withRoute,
    withoutRoute,
    routeDecisions,
    packUsage,
    fileUsage,
    dateUsage,
    reasonKeywords,
  };
}

function topN(obj, n = 10) {
  return Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

function printReport(stats) {
  console.log("\n" + "=".repeat(60));
  console.log("  Layered History Index - 路由日志分析报告");
  console.log("=".repeat(60));
  
  console.log("\n📊 总体统计");
  console.log("-".repeat(40));
  console.log(`总记录数：${stats.total}`);
  console.log(`有路由决策：${stats.withRoute} (${stats.total > 0 ? ((stats.withRoute / stats.total) * 100).toFixed(1) : 0}%)`);
  console.log(`无路由决策：${stats.withoutRoute} (${stats.total > 0 ? ((stats.withoutRoute / stats.total) * 100).toFixed(1) : 0}%)`);
  
  console.log("\n🎯 路由决策分布");
  console.log("-".repeat(40));
  console.log(`需要 L1 (决策记录): ${stats.routeDecisions.needsL1}`);
  console.log(`需要 L2 (完整对话): ${stats.routeDecisions.needsL2}`);
  console.log(`无需回忆：${stats.routeDecisions.noRecall}`);
  
  console.log("\n🔧 工具包使用 Top 10");
  console.log("-".repeat(40));
  const packs = topN(stats.packUsage, 10);
  if (packs.length === 0) {
    console.log("（无数据）");
  } else {
    for (const [pack, count] of packs) {
      console.log(`  ${pack}: ${count} 次`);
    }
  }
  
  console.log("\n📁 文件使用 Top 10");
  console.log("-".repeat(40));
  const files = topN(stats.fileUsage, 10);
  if (files.length === 0) {
    console.log("（无数据）");
  } else {
    for (const [file, count] of files) {
      console.log(`  ${file}: ${count} 次`);
    }
  }
  
  console.log("\n📅 日期分布 Top 10");
  console.log("-".repeat(40));
  const dates = topN(stats.dateUsage, 10);
  if (dates.length === 0) {
    console.log("（无数据）");
  } else {
    for (const [date, count] of dates) {
      console.log(`  ${date}: ${count} 次`);
    }
  }
  
  console.log("\n🔑 路由原因关键词 Top 10");
  console.log("-".repeat(40));
  const keywords = topN(stats.reasonKeywords, 10);
  if (keywords.length === 0) {
    console.log("（无数据）");
  } else {
    for (const [word, count] of keywords) {
      console.log(`  ${word}: ${count} 次`);
    }
  }
  
  console.log("\n" + "=".repeat(60));
  console.log("分析完成");
  console.log("=".repeat(60) + "\n");
}

// 主程序
const filePath = parseArgs();
console.log(`正在读取：${filePath}`);

const records = readLines(filePath);
console.log(`读取到 ${records.length} 条记录`);

const stats = analyze(records);
printReport(stats);
