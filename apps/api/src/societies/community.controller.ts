import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, AuthedRequest, JwtUser } from '../auth/jwt-auth.guard';
import { SocietyScopeGuard } from '../auth/society-scope.guard';
import { RequireRoles } from '../auth/require-roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { paramStr } from '../common/params';
import { CommunityService } from './community.service';
import {
  CreateAnnouncementDto,
  CreateMaintenanceTicketDto,
  UpdateMaintenanceTicketDto,
  CreateAmenityBookingDto,
  CreateMaintenanceInvoiceDto,
  RecordInvoicePaymentDto,
} from './community.dto';

@ApiTags('community')
@ApiBearerAuth()
@Controller('societies/:societyId')
@UseGuards(JwtAuthGuard, SocietyScopeGuard)
export class CommunityController {
  constructor(private readonly community: CommunityService) {}

  // =========================================================================
  // ANNOUNCEMENTS
  // =========================================================================

  @Get('announcements')
  listAnnouncements(@Req() req: AuthedRequest) {
    return this.community.listAnnouncements(paramStr(req.params.societyId));
  }

  @Post('announcements')
  @RequireRoles('SOCIETY_ADMIN')
  createAnnouncement(
    @CurrentUser() user: JwtUser,
    @Req() req: AuthedRequest,
    @Body() dto: CreateAnnouncementDto,
  ) {
    return this.community.createAnnouncement(user!, paramStr(req.params.societyId), dto);
  }

  @Delete('announcements/:announcementId')
  @RequireRoles('SOCIETY_ADMIN')
  deleteAnnouncement(
    @CurrentUser() user: JwtUser,
    @Req() req: AuthedRequest,
    @Param('announcementId') announcementId: string,
  ) {
    return this.community.deleteAnnouncement(user!, paramStr(req.params.societyId), announcementId);
  }

  // =========================================================================
  // MAINTENANCE TICKETS
  // =========================================================================

  @Get('maintenance-tickets')
  listTickets(
    @CurrentUser() user: JwtUser,
    @Req() req: AuthedRequest,
    @Query('flatId') flatId?: string,
  ) {
    return this.community.listTickets(
      user!,
      req.membership!.role,
      paramStr(req.params.societyId),
      flatId,
    );
  }

  @Post('maintenance-tickets')
  @RequireRoles('SOCIETY_ADMIN', 'RESIDENT')
  createTicket(
    @CurrentUser() user: JwtUser,
    @Req() req: AuthedRequest,
    @Body() dto: CreateMaintenanceTicketDto,
  ) {
    return this.community.createTicket(user!, paramStr(req.params.societyId), dto);
  }

  @Patch('maintenance-tickets/:ticketId')
  @RequireRoles('SOCIETY_ADMIN')
  updateTicket(
    @CurrentUser() user: JwtUser,
    @Req() req: AuthedRequest,
    @Param('ticketId') ticketId: string,
    @Body() dto: UpdateMaintenanceTicketDto,
  ) {
    return this.community.updateTicket(user!, paramStr(req.params.societyId), ticketId, dto);
  }

  // =========================================================================
  // AMENITY BOOKINGS
  // =========================================================================

  @Get('amenity-bookings')
  listBookings(
    @Req() req: AuthedRequest,
    @Query('flatId') flatId?: string,
  ) {
    return this.community.listBookings(paramStr(req.params.societyId), flatId);
  }

  @Post('amenity-bookings')
  @RequireRoles('SOCIETY_ADMIN', 'RESIDENT')
  createBooking(
    @CurrentUser() user: JwtUser,
    @Req() req: AuthedRequest,
    @Body() dto: CreateAmenityBookingDto,
  ) {
    return this.community.createBooking(user!, paramStr(req.params.societyId), dto);
  }

  @Delete('amenity-bookings/:bookingId')
  @RequireRoles('SOCIETY_ADMIN', 'RESIDENT')
  cancelBooking(
    @CurrentUser() user: JwtUser,
    @Req() req: AuthedRequest,
    @Param('bookingId') bookingId: string,
  ) {
    return this.community.cancelBooking(
      user!,
      req.membership!.role,
      paramStr(req.params.societyId),
      bookingId,
    );
  }

  // =========================================================================
  // MAINTENANCE BILLING & INVOICING
  // =========================================================================

  @Get('invoices')
  @RequireRoles('SOCIETY_ADMIN', 'RESIDENT')
  listInvoices(
    @CurrentUser() user: JwtUser,
    @Req() req: AuthedRequest,
    @Query('flatId') flatId?: string,
  ) {
    return this.community.listInvoices(
      user!,
      req.membership!.role,
      paramStr(req.params.societyId),
      flatId,
    );
  }

  @Post('invoices')
  @RequireRoles('SOCIETY_ADMIN')
  createInvoice(
    @CurrentUser() user: JwtUser,
    @Req() req: AuthedRequest,
    @Body() dto: CreateMaintenanceInvoiceDto,
  ) {
    return this.community.createInvoice(user!, paramStr(req.params.societyId), dto);
  }

  @Post('invoices/:invoiceId/pay')
  @RequireRoles('SOCIETY_ADMIN', 'RESIDENT')
  payInvoice(
    @CurrentUser() user: JwtUser,
    @Req() req: AuthedRequest,
    @Param('invoiceId') invoiceId: string,
    @Body() dto: RecordInvoicePaymentDto,
  ) {
    return this.community.recordPayment(
      user!,
      req.membership!.role,
      paramStr(req.params.societyId),
      invoiceId,
      dto,
    );
  }

  @Patch('invoices/:invoiceId/cancel')
  @RequireRoles('SOCIETY_ADMIN')
  cancelInvoice(
    @CurrentUser() user: JwtUser,
    @Req() req: AuthedRequest,
    @Param('invoiceId') invoiceId: string,
  ) {
    return this.community.cancelInvoice(user!, paramStr(req.params.societyId), invoiceId);
  }
}

