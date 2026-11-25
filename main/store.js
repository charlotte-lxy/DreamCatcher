'use strict'
const { app } = require('electron')
const fs = require('fs')
const path = require('path')

const DEFAULTS = {
  proxyMode: 'system', // system | direct | custom
  proxyUrl: '',
  downloadDir: '',
  concurrency: 2,
  maxSpeed: 0, // KB/s，0 表示不限速
  subAutoCheck: false, // 定时自动检测订阅更新
  subCheckInterval: 60 // 自动检测间隔（分钟）
}

function baseDir() {
  try {
    return app.getPath('userData')
  } catch (_) {
    return path.join(__dirname, '..', '.tmp')
  }
}

function file(name) {
  return path.join(baseDir(), name)
}

function read(name, fallback) {
  try {
    return Object.assign({}, fallback, JSON.parse(fs.readFileSync(file(name), 'utf8')))
  } catch (_) {
    return Object.assign({}, fallback)
  }
}

// 数组类数据（任务历史）用这个，避免对象合并把数组拍平
function readAny(name, fallback) {
  try {
    const v = JSON.parse(fs.readFileSync(file(name), 'utf8'))
    return Array.isArray(fallback) ? (Array.isArray(v) ? v : fallback) : v
  } catch (_) {
    return fallback
  }
}

// 先写临时文件再改名，避免进程中断留下半个 JSON；写失败也不能让调用方崩溃
function write(name, data) {
  try {
    fs.mkdirSync(baseDir(), { recursive: true })
    const tmp = file(name) + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, file(name))
    return true
  } catch (_) {
    return false
  }
}

module.exports = { DEFAULTS, read, readAny, write }
