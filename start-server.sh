#!/bin/bash

# 设置环境变量

# 缓存配置
CACHE_PATH=$(pwd)/cache
CACHE_ENABLED=true

# 时区
TZ=Asia/Shanghai

# 异步插件配置
ASYNC_PLUGIN_ENABLED=true
ASYNC_RESPONSE_TIMEOUT=4
ASYNC_MAX_BACKGROUND_WORKERS=20
ASYNC_MAX_BACKGROUND_TASKS=100
ASYNC_CACHE_TTL_HOURS=1

# 频道列表
CHANNELS=tgsearchers4,Aliyun_4K_Movies,bdbdndn11,yunpanx,bsbdbfjfjff,yp123pan,sbsbsnsqq,yunpanxunlei,tianyifc,BaiduCloudDisk,txtyzy,peccxinpd,gotopan,PanjClub,kkxlzy,baicaoZY,MCPH01,MCPH02,MCPH03,bdwpzhpd,ysxb48,jdjdn1111,yggpan,MCPH086,zaihuayun,Q66Share,ucwpzy,shareAliyun,alyp_1,dianyingshare,Quark_Movies,XiangxiuNBB,ydypzyfx,ucquark,xx123pan,yingshifenxiang123,zyfb123,tyypzhpd,tianyirigeng,cloudtianyi,hdhhd21,Lsp115,oneonefivewpfx,qixingzhenren,taoxgzy,Channel_Shares_115,tyysypzypd,vip115hot,wp123zy,yunpan139,yunpan189,yunpanuc,yydf_hzl,leoziyuan,pikpakpan,Q_dongman,yoyokuakeduanju,TG654TG,WFYSFX02,QukanMovie,yeqingjie_GJG666,movielover8888_film3,Baidu_netdisk,D_wusun,FLMdongtianfudi,KaiPanshare,QQZYDAPP,rjyxfx,PikPak_Share_Channel,btzhi,newproductsourcing,cctv1211,duan_ju,QuarkFree,yunpanNB,kkdj001,xxzlzn,pxyunpanxunlei,jxwpzy,kuakedongman,liangxingzhinan,xiangnikanj,solidsexydoll,guoman4K,zdqxm,kduanju,cilidianying,CBduanju,SharePanFilms,dzsgx,BooksRealm,Oscar_4Kmovies,douerpan,baidu_yppan,Q_jilupian,Netdisk_Movies,yunpanquark,ammmziyuan,ciliziyuanku,cili8888,jzmm_123pan

# 启用的插件列表
ENABLED_PLUGINS=labi,zhizhen,shandian,duoduo,muou,wanou,hunhepan,jikepan,panwiki,pansearch,panta,qupansou,hdr4k,pan666,susu,thepiratebay,xuexizhinan,panyq,ouge,huban,cyg,erxiao,miaoso,fox4k,pianku,clmao,wuji,cldi,xiaozhang,libvio,leijing,xb6v,xys,ddys,hdmoli,yuhuage,u3c3,javdb,clxiong,jutoushe,sdso,xiaoji,xdyh,haisou,bixin,djgou,nyaa,xinjuc,aikanzy,qupanshe,xdpan,discourse,yunsou,qqpd,ahhhhfs,nsgame,gying,quark4k,quarksoo,sousou,ash

# 认证配置
AUTH_ENABLED=false
AUTH_TOKEN_EXPIRY=24

# 导出环境变量
export CACHE_PATH CACHE_ENABLED TZ ASYNC_PLUGIN_ENABLED ASYNC_RESPONSE_TIMEOUT ASYNC_MAX_BACKGROUND_WORKERS ASYNC_MAX_BACKGROUND_TASKS ASYNC_CACHE_TTL_HOURS CHANNELS ENABLED_PLUGINS AUTH_ENABLED AUTH_TOKEN_EXPIRY

# 确保缓存目录存在
mkdir -p "$CACHE_PATH"

# 启动服务器
echo "正在启动服务器，使用以下配置："
echo "- 缓存路径: $CACHE_PATH"
echo "- 异步插件: $ASYNC_PLUGIN_ENABLED"
echo "- 启用插件数: $(echo $ENABLED_PLUGINS | tr ',' '\n' | wc -l)"
echo "- 频道数: $(echo $CHANNELS | tr ',' '\n' | wc -l)"
echo ""

./pansou-server
