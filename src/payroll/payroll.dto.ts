import { IsEnum, IsNumber, IsOptional, IsString } from 'class-validator';
import { PayslipLineCategory } from '@prisma/client';

export class SetRateDto {
  @IsString() employeeId: string;
  @IsNumber() hourlyRate: number;
}

export class GeneratePayrollDto {
  @IsString() start: string;
  @IsString() end: string;
  @IsOptional() @IsString() employeeId?: string;
}

export class AddPayslipLineDto {
  @IsEnum(PayslipLineCategory) category: PayslipLineCategory;
  @IsString() label: string;
  @IsNumber() amount: number;
}

export class UpdatePayslipLineDto {
  @IsOptional() @IsString() label?: string;
  @IsOptional() @IsNumber() amount?: number;
}
