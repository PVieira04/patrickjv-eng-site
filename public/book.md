# How to book a call with Patrick Vieira

1. Call `list_meeting_types` to see the options (Consultation, 30 minutes; Recruiter intro, 15 minutes).
2. Call `get_availability` with a type. It lists free times in London working hours, each with its UTC offset. Steps 1 and 2 need no sign-in.
3. Agree a time with your person.
4. Call `book_meeting` with the type, the start time and an optional note. Don't send their name or email address: those come from their sign-in. This doesn't reserve the time yet.
5. Give your person the `confirm_url` from the result. They open it and sign in with Google before `link_expires` (within 60 minutes). That books the call in their name, and Google sends them the invite. If someone else has taken the time in the meantime, the page tells them.
6. Call `get_booking_status` to check it's confirmed. Its status is one of `pending_confirmation`, `confirmed`, `declined`, `expired` or `cancelled`. If it says `pending_confirmation`, the booking isn't finished yet (your person may still be signing in, or the site may be finishing it): wait and check again, and don't book again. If it says `declined` or `expired`, start again from step 2.

To cancel, call `cancel_booking`. A request your person hasn't signed in on yet is withdrawn at once. If it returns a `confirm_url`, give it to your person: they sign in to cancel. If it says a cancellation email was sent, your person uses the link in that email. If it says the booking is still being finished, check again in a few minutes and cancel then. People can also book at https://patrickjv.com/book.
