import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export const ANNOUNCEMENT_CATEGORIES = ['GENERAL', 'EMERGENCY', 'MAINTENANCE', 'EVENT'] as const;
export type AnnouncementCategoryType = (typeof ANNOUNCEMENT_CATEGORIES)[number];

export const TICKET_CATEGORIES = ['PLUMBING', 'ELECTRICAL', 'LIFT', 'COMMON_AREA', 'CARPENTRY'] as const;
export type TicketCategoryType = (typeof TICKET_CATEGORIES)[number];

export const TICKET_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
export type TicketPriorityType = (typeof TICKET_PRIORITIES)[number];

export const TICKET_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const;
export type TicketStatusType = (typeof TICKET_STATUSES)[number];

export class CreateAnnouncementDto {
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title!: string;

  @IsString()
  @MinLength(5)
  @MaxLength(5000)
  content!: string;

  @IsIn(ANNOUNCEMENT_CATEGORIES)
  category!: AnnouncementCategoryType;

  @IsOptional()
  @IsBoolean()
  pinned?: boolean;
}

export class CreateMaintenanceTicketDto {
  @IsUUID()
  flatId!: string;

  @IsIn(TICKET_CATEGORIES)
  category!: TicketCategoryType;

  @IsIn(TICKET_PRIORITIES)
  @IsOptional()
  priority?: TicketPriorityType;

  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title!: string;

  @IsString()
  @MinLength(5)
  @MaxLength(3000)
  description!: string;
}

export class UpdateMaintenanceTicketDto {
  @IsOptional()
  @IsIn(TICKET_STATUSES)
  status?: TicketStatusType;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  assignedStaff?: string;
}

export class CreateAmenityBookingDto {
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  amenityName!: string;

  @IsUUID()
  flatId!: string;

  @IsDateString()
  slotStart!: string;

  @IsDateString()
  slotEnd!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  guestCount?: number;
}

export const INVOICE_STATUSES = ['PENDING', 'PAID', 'OVERDUE', 'CANCELLED'] as const;
export type InvoiceStatusType = (typeof INVOICE_STATUSES)[number];

export class CreateMaintenanceInvoiceDto {
  @IsUUID()
  flatId!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsNumber()
  @Min(1)
  amount!: number;

  @IsDateString()
  dueDate!: string;
}

export class RecordInvoicePaymentDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  paymentReference?: string;

  @IsOptional()
  @IsDateString()
  paidAt?: string;
}

