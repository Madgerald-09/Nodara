use anchor_lang::prelude::*;

declare_id!("CrNexJmcsgEnjAUW3fLeMQNP1k8kcSGm1wn8vYKBUwf");

#[program]
pub mod nodara_tickets {
    use super::*;

    pub fn create_event(ctx: Context<CreateEvent>, event_id: [u8; 16], transfers_allowed: bool) -> Result<()> {
        let event = &mut ctx.accounts.event;
        event.event_id = event_id;
        event.organizer = ctx.accounts.organizer.key();
        event.transfers_allowed = transfers_allowed;
        event.bump = ctx.bumps.event;
        Ok(())
    }

    pub fn set_transfer_policy(ctx: Context<ManageEvent>, allowed: bool) -> Result<()> {
        ctx.accounts.event.transfers_allowed = allowed;
        Ok(())
    }

    // Issuance authority is the organiser. The app must check the Supabase booking is
    // confirmed before requesting a transaction; programs cannot query Supabase.
    pub fn register_ticket(ctx: Context<RegisterTicket>, ticket_id: [u8; 16]) -> Result<()> {
        require_keys_neq!(ctx.accounts.initial_owner.key(), Pubkey::default(), TicketError::InvalidRecipient);
        let ticket = &mut ctx.accounts.ticket;
        ticket.ticket_id = ticket_id;
        ticket.event = ctx.accounts.event.key();
        ticket.issuer = ctx.accounts.organizer.key();
        ticket.owner = ctx.accounts.initial_owner.key();
        ticket.valid = true;
        ticket.checked_in = false;
        ticket.transfer_count = 0;
        ticket.bump = ctx.bumps.ticket;
        Ok(())
    }

    pub fn transfer_ticket(ctx: Context<TransferTicket>, _ticket_id: [u8; 16]) -> Result<()> {
        let ticket = &mut ctx.accounts.ticket;
        require!(ticket.valid, TicketError::InvalidTicket);
        require!(!ticket.checked_in, TicketError::AlreadyCheckedIn);
        require!(ctx.accounts.event.transfers_allowed, TicketError::TransfersDisabled);
        require!(ticket.owner == ctx.accounts.current_owner.key(), TicketError::NotOwner);
        require_keys_neq!(ctx.accounts.recipient.key(), Pubkey::default(), TicketError::InvalidRecipient);
        require!(ctx.accounts.recipient.key() != ticket.owner, TicketError::SameOwner);
        let sequence = ticket.transfer_count;
        let receipt = &mut ctx.accounts.receipt;
        receipt.ticket = ticket.key();
        receipt.from = ctx.accounts.current_owner.key();
        receipt.to = ctx.accounts.recipient.key();
        receipt.sequence = sequence;
        receipt.bump = ctx.bumps.receipt;
        ticket.owner = ctx.accounts.recipient.key();
        ticket.transfer_count = ticket.transfer_count.checked_add(1).ok_or(TicketError::CounterOverflow)?;
        Ok(())
    }

    pub fn check_in_ticket(ctx: Context<CheckInTicket>, _ticket_id: [u8; 16]) -> Result<()> {
        let ticket = &mut ctx.accounts.ticket;
        require!(ticket.valid, TicketError::InvalidTicket);
        require!(!ticket.checked_in, TicketError::AlreadyCheckedIn);
        ticket.checked_in = true;
        Ok(())
    }

    pub fn invalidate_ticket(ctx: Context<ManageTicket>, _ticket_id: [u8; 16]) -> Result<()> {
        ctx.accounts.ticket.valid = false;
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(event_id: [u8; 16])]
pub struct CreateEvent<'info> {
    #[account(mut)] pub organizer: Signer<'info>,
    #[account(init, payer = organizer, space = 8 + EventRecord::INIT_SPACE, seeds = [b"event", event_id.as_ref()], bump)]
    pub event: Account<'info, EventRecord>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ManageEvent<'info> {
    pub organizer: Signer<'info>,
    #[account(mut, has_one = organizer, seeds = [b"event", event.event_id.as_ref()], bump = event.bump)]
    pub event: Account<'info, EventRecord>,
}

#[derive(Accounts)]
#[instruction(ticket_id: [u8; 16])]
pub struct RegisterTicket<'info> {
    #[account(mut)] pub organizer: Signer<'info>,
    #[account(has_one = organizer, seeds = [b"event", event.event_id.as_ref()], bump = event.bump)]
    pub event: Account<'info, EventRecord>,
    /// CHECK: This account is stored only as a public-key owner; no data is read.
    pub initial_owner: UncheckedAccount<'info>,
    #[account(init, payer = organizer, space = 8 + TicketRecord::INIT_SPACE,
      seeds = [b"ticket", event.key().as_ref(), ticket_id.as_ref()], bump)]
    pub ticket: Account<'info, TicketRecord>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(ticket_id: [u8; 16])]
pub struct TransferTicket<'info> {
    #[account(mut)] pub current_owner: Signer<'info>,
    #[account(seeds = [b"event", event.event_id.as_ref()], bump = event.bump)] pub event: Account<'info, EventRecord>,
    #[account(mut, has_one = event, seeds = [b"ticket", event.key().as_ref(), ticket_id.as_ref()], bump = ticket.bump,
      constraint = ticket.owner == current_owner.key() @ TicketError::NotOwner)]
    pub ticket: Account<'info, TicketRecord>,
    /// CHECK: This account is stored only as a public-key owner; no data is read.
    pub recipient: UncheckedAccount<'info>,
    #[account(init, payer = current_owner, space = 8 + TransferReceipt::INIT_SPACE,
      seeds = [b"transfer", ticket.key().as_ref(), ticket.transfer_count.to_le_bytes().as_ref()], bump)]
    pub receipt: Account<'info, TransferReceipt>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(ticket_id: [u8; 16])]
pub struct CheckInTicket<'info> {
    pub organizer: Signer<'info>,
    #[account(has_one = organizer, seeds = [b"event", event.event_id.as_ref()], bump = event.bump)]
    pub event: Account<'info, EventRecord>,
    #[account(mut, has_one = event, seeds = [b"ticket", event.key().as_ref(), ticket_id.as_ref()], bump = ticket.bump)]
    pub ticket: Account<'info, TicketRecord>,
}

#[derive(Accounts)]
#[instruction(ticket_id: [u8; 16])]
pub struct ManageTicket<'info> {
    pub organizer: Signer<'info>,
    #[account(has_one = organizer, seeds = [b"event", event.event_id.as_ref()], bump = event.bump)]
    pub event: Account<'info, EventRecord>,
    #[account(mut, has_one = event, seeds = [b"ticket", event.key().as_ref(), ticket_id.as_ref()], bump = ticket.bump)]
    pub ticket: Account<'info, TicketRecord>,
}

#[account]
#[derive(InitSpace)]
pub struct EventRecord { pub event_id: [u8; 16], pub organizer: Pubkey, pub transfers_allowed: bool, pub bump: u8 }

#[account]
#[derive(InitSpace)]
pub struct TicketRecord {
    pub ticket_id: [u8; 16], pub event: Pubkey, pub issuer: Pubkey, pub owner: Pubkey,
    pub valid: bool, pub checked_in: bool, pub transfer_count: u32, pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct TransferReceipt { pub ticket: Pubkey, pub from: Pubkey, pub to: Pubkey, pub sequence: u32, pub bump: u8 }

#[error_code]
pub enum TicketError {
    #[msg("Ticket is invalid or cancelled")] InvalidTicket,
    #[msg("Ticket has already been checked in")] AlreadyCheckedIn,
    #[msg("The event does not allow transfers")] TransfersDisabled,
    #[msg("Only the current owner may transfer this ticket")] NotOwner,
    #[msg("Transfer history counter overflowed")] CounterOverflow,
    #[msg("Recipient address cannot be the default public key")] InvalidRecipient,
    #[msg("Ticket is already owned by this recipient")] SameOwner,
}
