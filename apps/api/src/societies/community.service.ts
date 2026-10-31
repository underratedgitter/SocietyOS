import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { AuthzService } from '../common/authz.service';
import { AuditService } from '../common/audit.service';
import { AppException } from '../common/app.exception';
import { JwtUser } from '../auth/jwt-auth.guard';
import {
  CreateAnnouncementDto,
  CreateMaintenanceTicketDto,
  UpdateMaintenanceTicketDto,
  CreateAmenityBookingDto,
  CreateMaintenanceInvoiceDto,
  RecordInvoicePaymentDto,
} from './community.dto';

@Injectable()
export class CommunityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
  ) {}

  // =========================================================================
  // ANNOUNCEMENTS
  // =========================================================================

  async listAnnouncements(societyId: string) {
    return this.prisma.announcement.findMany({
      where: { societyId },
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
      include: {
        author: { select: { name: true } },
      },
    });
  }

  async createAnnouncement(user: JwtUser, societyId: string, dto: CreateAnnouncementDto) {
    const announcement = await this.prisma.announcement.create({
      data: {
        societyId,
        authorId: user.sub,
        title: dto.title.trim(),
        content: dto.content.trim(),
        category: dto.category,
        pinned: dto.pinned ?? false,
      },
      include: { author: { select: { name: true } } },
    });

    await this.audit.record({
      societyId,
      actorUserId: user.sub,
      action: 'ANNOUNCEMENT_CREATED',
      entityType: 'Announcement',
      entityId: announcement.id,
      meta: { title: announcement.title, category: announcement.category, pinned: announcement.pinned },
    });

    return announcement;
  }

  async deleteAnnouncement(user: JwtUser, societyId: string, announcementId: string) {
    const existing = await this.prisma.announcement.findUnique({
      where: { id: announcementId },
    });
    if (!existing || existing.societyId !== societyId) {
      throw AppException.notFound('ANNOUNCEMENT_NOT_FOUND', 'Announcement not found in this society');
    }

    await this.prisma.announcement.delete({ where: { id: announcementId } });

    await this.audit.record({
      societyId,
      actorUserId: user.sub,
      action: 'ANNOUNCEMENT_DELETED',
      entityType: 'Announcement',
      entityId: announcementId,
      meta: { title: existing.title },
    });

    return { ok: true };
  }

  // =========================================================================
  // MAINTENANCE TICKETS
  // =========================================================================

  async listTickets(user: JwtUser, role: string, societyId: string, flatId?: string) {
    const where: any = { societyId };

    if (role === 'RESIDENT') {
      if (flatId) {
        await this.authz.assertResidentOfFlat(user.sub, flatId);
        where.flatId = flatId;
      } else {
        const memberships = await this.prisma.residentFlatMembership.findMany({
          where: { userId: user.sub, endedAt: null, flat: { building: { societyId } } },
          select: { flatId: true },
        });
        where.flatId = { in: memberships.map((m) => m.flatId) };
      }
    } else if (flatId) {
      where.flatId = flatId;
    }

    return this.prisma.maintenanceTicket.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        flat: {
          select: {
            id: true,
            flatNumber: true,
            building: { select: { name: true } },
          },
        },
        createdBy: { select: { name: true, email: true } },
      },
    });
  }

  async createTicket(user: JwtUser, societyId: string, dto: CreateMaintenanceTicketDto) {
    const flat = await this.prisma.flat.findUnique({
      where: { id: dto.flatId },
      include: { building: true },
    });
    if (!flat || flat.building.societyId !== societyId) {
      throw AppException.notFound('FLAT_NOT_FOUND', 'Flat not found in this society');
    }

    // Residents must be authorized members of that flat
    const membership = await this.prisma.societyMembership.findUnique({
      where: { societyId_userId: { societyId, userId: user.sub } },
    });
    if (membership?.role === 'RESIDENT') {
      await this.authz.assertResidentOfFlat(user.sub, dto.flatId);
    }

    const ticket = await this.prisma.maintenanceTicket.create({
      data: {
        societyId,
        flatId: dto.flatId,
        createdById: user.sub,
        category: dto.category,
        priority: dto.priority ?? 'MEDIUM',
        title: dto.title.trim(),
        description: dto.description.trim(),
        status: 'OPEN',
      },
      include: {
        flat: {
          select: {
            id: true,
            flatNumber: true,
            building: { select: { name: true } },
          },
        },
        createdBy: { select: { name: true } },
      },
    });

    await this.audit.record({
      societyId,
      actorUserId: user.sub,
      action: 'TICKET_CREATED',
      entityType: 'MaintenanceTicket',
      entityId: ticket.id,
      meta: { title: ticket.title, category: ticket.category, priority: ticket.priority },
    });

    return ticket;
  }

  async updateTicket(user: JwtUser, societyId: string, ticketId: string, dto: UpdateMaintenanceTicketDto) {
    const existing = await this.prisma.maintenanceTicket.findUnique({
      where: { id: ticketId },
    });
    if (!existing || existing.societyId !== societyId) {
      throw AppException.notFound('TICKET_NOT_FOUND', 'Maintenance ticket not found in this society');
    }

    const ticket = await this.prisma.maintenanceTicket.update({
      where: { id: ticketId },
      data: {
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.assignedStaff !== undefined ? { assignedStaff: dto.assignedStaff ? dto.assignedStaff.trim() : null } : {}),
      },
      include: {
        flat: {
          select: {
            id: true,
            flatNumber: true,
            building: { select: { name: true } },
          },
        },
        createdBy: { select: { name: true } },
      },
    });

    await this.audit.record({
      societyId,
      actorUserId: user.sub,
      action: 'TICKET_UPDATED',
      entityType: 'MaintenanceTicket',
      entityId: ticket.id,
      meta: { previousStatus: existing.status, newStatus: ticket.status, assignedStaff: ticket.assignedStaff },
    });

    return ticket;
  }

  // =========================================================================
  // AMENITY BOOKINGS
  // =========================================================================

  async listBookings(societyId: string, flatId?: string) {
    return this.prisma.amenityBooking.findMany({
      where: {
        societyId,
        ...(flatId ? { flatId } : {}),
      },
      orderBy: { slotStart: 'asc' },
      include: {
        flat: {
          select: {
            id: true,
            flatNumber: true,
            building: { select: { name: true } },
          },
        },
        bookedBy: { select: { name: true } },
      },
    });
  }

  async createBooking(user: JwtUser, societyId: string, dto: CreateAmenityBookingDto) {
    const flat = await this.prisma.flat.findUnique({
      where: { id: dto.flatId },
      include: { building: true },
    });
    if (!flat || flat.building.societyId !== societyId) {
      throw AppException.notFound('FLAT_NOT_FOUND', 'Flat not found in this society');
    }

    await this.authz.assertResidentOfFlat(user.sub, dto.flatId);

    const start = new Date(dto.slotStart);
    const end = new Date(dto.slotEnd);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw AppException.unprocessable('INVALID_TIME_FORMAT', 'Booking timestamps are invalid');
    }

    if (start >= end) {
      throw AppException.unprocessable('INVALID_TIME_RANGE', 'Booking end time must be strictly after start time');
    }

    if (start.getTime() < Date.now() - 300_000) {
      throw AppException.unprocessable('SLOT_IN_PAST', 'Cannot book an amenity slot in the past');
    }

    // Double-booking conflict check
    const normalizedAmenity = dto.amenityName.trim();
    const conflict = await this.prisma.amenityBooking.findFirst({
      where: {
        societyId,
        status: 'CONFIRMED',
        amenityName: { equals: normalizedAmenity, mode: 'insensitive' },
        AND: [
          { slotStart: { lt: end } },
          { slotEnd: { gt: start } },
        ],
      },
    });

    if (conflict) {
      throw AppException.conflict('AMENITY_SLOT_UNAVAILABLE', 'This amenity is already booked for that time window');
    }

    const booking = await this.prisma.amenityBooking.create({
      data: {
        societyId,
        flatId: dto.flatId,
        bookedById: user.sub,
        amenityName: normalizedAmenity,
        slotStart: start,
        slotEnd: end,
        guestCount: dto.guestCount ?? 1,
        status: 'CONFIRMED',
      },
      include: {
        flat: {
          select: {
            id: true,
            flatNumber: true,
            building: { select: { name: true } },
          },
        },
        bookedBy: { select: { name: true } },
      },
    });

    await this.audit.record({
      societyId,
      actorUserId: user.sub,
      action: 'AMENITY_BOOKED',
      entityType: 'AmenityBooking',
      entityId: booking.id,
      meta: { amenity: booking.amenityName, slotStart: start.toISOString(), slotEnd: end.toISOString() },
    });

    return booking;
  }

  async cancelBooking(user: JwtUser, role: string, societyId: string, bookingId: string) {
    const existing = await this.prisma.amenityBooking.findUnique({
      where: { id: bookingId },
    });
    if (!existing || existing.societyId !== societyId) {
      throw AppException.notFound('BOOKING_NOT_FOUND', 'Amenity booking not found in this society');
    }

    if (role === 'RESIDENT' && existing.bookedById !== user.sub) {
      throw AppException.forbidden('NOT_YOUR_BOOKING', 'You can only cancel your own amenity bookings');
    }

    const booking = await this.prisma.amenityBooking.update({
      where: { id: bookingId },
      data: { status: 'CANCELLED' },
    });

    await this.audit.record({
      societyId,
      actorUserId: user.sub,
      action: 'AMENITY_BOOKING_CANCELLED',
      entityType: 'AmenityBooking',
      entityId: bookingId,
      meta: { amenity: existing.amenityName },
    });

    return booking;
  }

  // =========================================================================
  // MAINTENANCE BILLING & INVOICING
  // =========================================================================

  async listInvoices(user: JwtUser, role: string, societyId: string, flatId?: string) {
    const where: any = { societyId };

    if (role === 'RESIDENT') {
      if (flatId) {
        await this.authz.assertResidentOfFlat(user.sub, flatId);
        where.flatId = flatId;
      } else {
        const memberships = await this.prisma.residentFlatMembership.findMany({
          where: { userId: user.sub, endedAt: null, flat: { building: { societyId } } },
          select: { flatId: true },
        });
        where.flatId = { in: memberships.map((m) => m.flatId) };
      }
    } else if (flatId) {
      where.flatId = flatId;
    }

    const invoices = await this.prisma.maintenanceInvoice.findMany({
      where,
      orderBy: { dueDate: 'desc' },
      include: {
        flat: {
          select: {
            id: true,
            flatNumber: true,
            building: { select: { name: true } },
          },
        },
        paidBy: { select: { id: true, name: true, email: true } },
      },
    });

    const now = new Date();
    return invoices.map((inv) => {
      if (inv.status === 'PENDING' && new Date(inv.dueDate) < now) {
        return { ...inv, status: 'OVERDUE' as const };
      }
      return inv;
    });
  }

  async createInvoice(user: JwtUser, societyId: string, dto: CreateMaintenanceInvoiceDto) {
    const flat = await this.prisma.flat.findUnique({
      where: { id: dto.flatId },
      include: { building: true },
    });
    if (!flat || flat.building.societyId !== societyId) {
      throw AppException.notFound('FLAT_NOT_FOUND', 'Flat not found in this society');
    }

    const dueDate = new Date(dto.dueDate);
    if (Number.isNaN(dueDate.getTime())) {
      throw AppException.unprocessable('INVALID_DUE_DATE', 'Invoice due date is invalid');
    }

    const invoice = await this.prisma.maintenanceInvoice.create({
      data: {
        societyId,
        flatId: dto.flatId,
        title: dto.title.trim(),
        description: dto.description?.trim(),
        amount: dto.amount,
        dueDate,
        status: 'PENDING',
      },
      include: {
        flat: {
          select: {
            id: true,
            flatNumber: true,
            building: { select: { name: true } },
          },
        },
      },
    });

    await this.audit.record({
      societyId,
      actorUserId: user.sub,
      action: 'INVOICE_CREATED',
      entityType: 'MaintenanceInvoice',
      entityId: invoice.id,
      meta: { title: invoice.title, amount: invoice.amount, flatId: invoice.flatId },
    });

    return invoice;
  }

  async recordPayment(
    user: JwtUser,
    role: string,
    societyId: string,
    invoiceId: string,
    dto: RecordInvoicePaymentDto,
  ) {
    const existing = await this.prisma.maintenanceInvoice.findUnique({
      where: { id: invoiceId },
      include: { flat: { include: { building: true } } },
    });
    if (!existing || existing.societyId !== societyId) {
      throw AppException.notFound('INVOICE_NOT_FOUND', 'Invoice not found in this society');
    }

    if (existing.status === 'PAID') {
      throw AppException.conflict('INVOICE_ALREADY_PAID', 'Invoice has already been settled');
    }

    if (existing.status === 'CANCELLED') {
      throw AppException.unprocessable('INVOICE_CANCELLED', 'Cannot pay a cancelled invoice');
    }

    if (role === 'RESIDENT') {
      await this.authz.assertResidentOfFlat(user.sub, existing.flatId);
    }

    const paidAt = dto.paidAt ? new Date(dto.paidAt) : new Date();
    if (Number.isNaN(paidAt.getTime())) {
      throw AppException.unprocessable('INVALID_PAYMENT_DATE', 'Payment timestamp is invalid');
    }

    const invoice = await this.prisma.maintenanceInvoice.update({
      where: { id: invoiceId },
      data: {
        status: 'PAID',
        paidAt,
        paidById: user.sub,
        paymentReference: dto.paymentReference?.trim() || `TXN-${Date.now()}`,
      },
      include: {
        flat: {
          select: {
            id: true,
            flatNumber: true,
            building: { select: { name: true } },
          },
        },
        paidBy: { select: { id: true, name: true, email: true } },
      },
    });

    await this.audit.record({
      societyId,
      actorUserId: user.sub,
      action: 'INVOICE_PAID',
      entityType: 'MaintenanceInvoice',
      entityId: invoice.id,
      meta: { amount: invoice.amount, paymentReference: invoice.paymentReference },
    });

    return invoice;
  }

  async cancelInvoice(user: JwtUser, societyId: string, invoiceId: string) {
    const existing = await this.prisma.maintenanceInvoice.findUnique({
      where: { id: invoiceId },
    });
    if (!existing || existing.societyId !== societyId) {
      throw AppException.notFound('INVOICE_NOT_FOUND', 'Invoice not found in this society');
    }

    if (existing.status === 'PAID') {
      throw AppException.conflict('INVOICE_ALREADY_PAID', 'Cannot cancel an invoice that has already been paid');
    }

    const invoice = await this.prisma.maintenanceInvoice.update({
      where: { id: invoiceId },
      data: { status: 'CANCELLED' },
      include: {
        flat: {
          select: {
            id: true,
            flatNumber: true,
            building: { select: { name: true } },
          },
        },
      },
    });

    await this.audit.record({
      societyId,
      actorUserId: user.sub,
      action: 'INVOICE_CANCELLED',
      entityType: 'MaintenanceInvoice',
      entityId: invoice.id,
      meta: { title: existing.title },
    });

    return invoice;
  }
}

