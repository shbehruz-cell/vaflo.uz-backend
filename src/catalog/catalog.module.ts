import { Module } from '@nestjs/common';
import { CategoriesController } from './categories.controller.js';
import { CategoriesService } from './categories.service.js';
import { ProductsController } from './products.controller.js';
import { ProductsService } from './products.service.js';
import { ProductImportService } from './product-import.service.js';

@Module({
  controllers: [CategoriesController, ProductsController],
  providers: [CategoriesService, ProductsService, ProductImportService],
  exports: [ProductsService],
})
export class CatalogModule {}
