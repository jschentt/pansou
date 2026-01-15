import { Controller, Get, Post, Query, Body, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SearchService } from '../../services/search.service';
import { SearchRequest } from '../../models/search-request';
import { AppConfig } from '../../config/config';

@ApiTags('search')
@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Post()
  async search(@Body() request: SearchRequest) {
    // 检查并设置默认值
    return this.processSearchRequest(request);
  }

  @Get()
  async searchGet(
    @Query('kw') keyword: string,
    @Query('channels') channels?: string,
    @Query('conc') concurrency?: string,
    @Query('refresh') forceRefresh?: string,
    @Query('res') resultType?: string,
    @Query('src') sourceType?: string,
    @Query('plugins') plugins?: string,
    @Query('cloud_types') cloudTypes?: string,
    @Query('ext') ext?: string,
    @Query('filter') filter?: string,
  ) {
    // 构建请求对象
    const request: SearchRequest = {
      keyword,
      channels: [],
      concurrency: concurrency ? parseInt(concurrency, 10) : 0,
      forceRefresh: forceRefresh === 'true',
      resultType: resultType || '',
      sourceType: sourceType || '',
      plugins: undefined,
      cloudTypes: undefined,
      ext: {},
      filter: filter ? JSON.parse(filter) : undefined,
    };

    // 处理channels参数，支持逗号分隔
    if (channels && channels !== ' ') {
      request.channels = channels.split(',').map(channel => channel.trim()).filter(channel => channel !== '');
    }

    // 处理plugins参数，支持逗号分隔
    if (plugins && plugins !== ' ') {
      request.plugins = plugins.split(',').map(plugin => plugin.trim()).filter(plugin => plugin !== '');
    }

    // 处理cloud_types参数，支持逗号分隔
    if (cloudTypes && cloudTypes !== ' ') {
      request.cloudTypes = cloudTypes.split(',').map(type => type.trim()).filter(type => type !== '');
    }

    // 处理ext参数，JSON格式
    if (ext && ext !== ' ') {
      try {
        if (ext === '{}') {
          request.ext = {};
        } else {
          request.ext = JSON.parse(ext);
        }
      } catch (error) {
        throw new BadRequestException(`无效的ext参数格式: ${error.message}`);
      }
    }

    return this.processSearchRequest(request);
  }

  // 处理搜索请求的通用逻辑
  private async processSearchRequest(request: SearchRequest) {
    // 检查并设置默认值
    if (!request.keyword) {
      throw new BadRequestException('关键词(kw)是必填参数');
    }

    if (!request.channels || request.channels.length === 0) {
      request.channels = AppConfig?.defaultChannels || [];
    }

    // 如果未指定结果类型，默认返回merge并转换为merged_by_type
    if (!request.resultType) {
      request.resultType = 'merged_by_type';
    } else if (request.resultType === 'merge') {
      // 将merge转换为merged_by_type，以兼容内部处理
      request.resultType = 'merged_by_type';
    }

    // 如果未指定数据来源类型，默认为全部
    if (!request.sourceType) {
      request.sourceType = 'all';
    }

    // 参数互斥逻辑：当src=tg时忽略plugins参数，当src=plugin时忽略channels参数
    if (request.sourceType === 'tg') {
      request.plugins = undefined; // 忽略plugins参数
    } else if (request.sourceType === 'plugin') {
      request.channels = undefined; // 忽略channels参数
    } else if (request.sourceType === 'all') {
      // 对于all类型，如果plugins为空或不存在，统一设为undefined
      if (!request.plugins || request.plugins.length === 0) {
        request.plugins = undefined;
      }
    }

    // 确保ext不为null或undefined
    if (!request.ext) {
      request.ext = {};
    }

    try {
      // 执行搜索
      return await this.searchService.search(request);
    } catch (error) {
      throw new InternalServerErrorException(`搜索失败: ${error.message}`);
    }
  }
}
