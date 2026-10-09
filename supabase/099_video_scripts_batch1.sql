-- Video Studio batch 1 (2026-10-09): 4 scripts each for Taeya (English), Fanis (Spanish) and
-- Theresa (Vietnamese). Same four topics in each language. Business-purpose / investor only.
-- Numbers used are the ones already in our live ads (up to 90% of purchase, 100% of rehab).

delete from public.video_scripts where id like 'b1-%';

-- Shared notes
-- wardrobe / location / shot notes are written per script below (English, for all three).

insert into public.video_scripts (id, user_id, lang, sort, title, hook, script, wardrobe, location, shot_notes) values

-- ===== TAEYA -- ENGLISH =====
('b1-en-1','lo-taeya','en',1,$q$3 numbers to check before you make an offer$q$,
 $q$Before you make an offer on a flip, check these three numbers.$q$,
 $q$Before you make an offer on a flip, check these three numbers.
One: the ARV. What similar homes nearby actually SOLD for, not what they're listed at.
Two: your full rehab budget, plus ten to fifteen percent for surprises.
Three: your holding costs. Interest, taxes, insurance and utilities for every month you own it.
If the deal still makes money after all three, it's a deal.
I'm Taeya with Bridgepoint Lending. Send me the address and I'll run the numbers with you, free.
Investment properties only.$q$,
 $q$Solid blazer or a nice sweater (navy, gray, black or white) over a plain top. No big logos, no busy patterns, no stripes. Natural makeup, hair away from your face. Same outfit is fine for all four videos.$q$,
 $q$Outside a house that looks like a fixer-upper, filmed from the sidewalk, or in front of any house being renovated. Daytime. Stand so the sun is on your face (behind the person filming), not behind you.$q$,
 $q$Phone held VERTICAL. Back camera if someone films you, front camera if you film yourself. Eye level, about an arm's length away, chest up in frame. Quiet spot, no music. Say the first line within the first 2 seconds, smile, then go. 30-45 seconds total. Do 2-3 takes and upload them all.$q$),

('b1-en-2','lo-taeya','en',2,$q$Why your bank said no to your flip$q$,
 $q$If your bank said no to your flip, here's why.$q$,
 $q$If your bank said no to your flip, here's why.
Banks look at YOU. Your W-2s, your tax returns, your debt-to-income.
We look at the DEAL.
At Bridgepoint we can finance up to 90% of the purchase and 100% of the rehab on deals that qualify, and we fund the rehab in draws as the work gets done. No tax returns, no W-2s.
If you've got a flip under contract, send it to me and I'll tell you what we can do.
I'm Taeya with Bridgepoint Lending. Investment properties only.$q$,
 $q$Same as video 1: solid blazer or sweater, plain top, no logos or patterns.$q$,
 $q$Inside a room that's mid-renovation (bare drywall, exposed studs, tools or ladders in the background is perfect). If you can't get into one, a clean, bright kitchen or office with a plain wall behind you.$q$,
 $q$Phone VERTICAL, eye level, chest up. Face the window so the light is on your face. 30-45 seconds. 2-3 takes.$q$),

('b1-en-3','lo-taeya','en',3,$q$DSCR loans in 30 seconds$q$,
 $q$Want to buy rentals without showing your tax returns? Listen to this.$q$,
 $q$Want to buy rentals without showing your tax returns? Listen to this.
It's called a DSCR loan. Instead of your personal income, we look at the property: does the rent cover the mortgage payment?
If it does, you can qualify. Even if you're self-employed. Even if your tax returns show a loss.
You can close in your LLC, and it works for purchases and cash-out refinances.
I'm Taeya with Bridgepoint Lending. Comment RENT or send me a message and I'll show you the numbers.$q$,
 $q$Same outfit as the others is fine, or a solid-color button-down. Keep it professional but relaxed.$q$,
 $q$In front of a house or duplex that looks like a rental (a nice, well-kept one), or a row of townhomes. Daytime, sun on your face.$q$,
 $q$Phone VERTICAL, eye level, chest up. 30-45 seconds. Say "Comment RENT" clearly and slowly at the end. 2-3 takes.$q$),

('b1-en-4','lo-taeya','en',4,$q$The rehab mistake that kills first flips$q$,
 $q$This one mistake kills more first flips than anything else.$q$,
 $q$This one mistake kills more first flips than anything else: running out of rehab money.
You buy the house, start demo, find a problem behind the wall, and the cash is gone.
Three fixes. One: get a contractor's bid BEFORE you buy. Two: add ten to fifteen percent for surprises. Three: use a loan that funds the rehab in draws, so it's not all coming out of your pocket.
That's what we do at Bridgepoint Lending. Send me your rehab budget and I'll look it over with you.
Investment properties only.$q$,
 $q$Same as the others. Optional: hold a printed rehab budget or a clipboard.$q$,
 $q$At a job site: in front of a house with a dumpster, a work truck or scaffolding. If not, outside any house under renovation. Stay off the actual work area and wear closed shoes.$q$,
 $q$Phone VERTICAL, eye level, chest up. If it's noisy, move closer to the phone or step away from the work. 30-45 seconds. 2-3 takes.$q$),

-- ===== FANIS -- SPANISH (Fanis is a woman: asesora) =====
('b1-es-1','lo-fanis','es',1,$q$3 números antes de hacer una oferta$q$,
 $q$Antes de hacer una oferta en un fix and flip, revisa estos tres números.$q$,
 $q$Antes de hacer una oferta en un fix and flip, revisa estos tres números.
Uno: el ARV. Lo que casas parecidas cerca realmente se VENDIERON, no el precio de lista.
Dos: tu presupuesto completo de reparación, más un diez a quince por ciento para sorpresas.
Tres: tus costos mientras tienes la propiedad. Intereses, impuestos, seguro y servicios, cada mes.
Si el negocio todavía deja ganancia después de esos tres, es un buen negocio.
Soy Fanis, asesora de préstamos en Bridgepoint Lending. Mándame la dirección y te ayudo a revisar los números, gratis.
Solo propiedades de inversión.$q$,
 $q$Solid blazer or a nice sweater (navy, gray, black or white) over a plain top. No big logos, no busy patterns, no stripes. Natural makeup, hair away from your face. Same outfit is fine for all four videos.$q$,
 $q$Outside a house that looks like a fixer-upper, filmed from the sidewalk, or in front of any house being renovated. Daytime. Stand so the sun is on your face (behind the person filming), not behind you.$q$,
 $q$Phone held VERTICAL. Back camera if someone films you, front camera if you film yourself. Eye level, about an arm's length away, chest up in frame. Quiet spot, no music. Say the first line within the first 2 seconds, smile, then go. 30-45 seconds total. Do 2-3 takes and upload them all. Say it in your own natural Spanish; keep the numbers and the last line.$q$),

('b1-es-2','lo-fanis','es',2,$q$Por qué el banco te dijo que no$q$,
 $q$Si el banco te dijo que no a tu fix and flip, esta es la razón.$q$,
 $q$Si el banco te dijo que no a tu fix and flip, esta es la razón.
Los bancos te miran a TI. Tus W-2, tus declaraciones de impuestos, tus deudas.
Nosotros miramos el NEGOCIO.
En Bridgepoint podemos financiar hasta el 90% de la compra y el 100% de la reparación en propiedades que califican, y el dinero de la reparación se entrega por etapas mientras avanza el trabajo. Sin declaraciones de impuestos, sin W-2.
Si tienes una propiedad bajo contrato, mándamela y te digo qué podemos hacer.
Soy Fanis, de Bridgepoint Lending. Solo propiedades de inversión.$q$,
 $q$Same as video 1: solid blazer or sweater, plain top, no logos or patterns.$q$,
 $q$Inside a room that's mid-renovation (bare drywall, exposed studs, tools or ladders in the background is perfect). If you can't get into one, a clean, bright kitchen or office with a plain wall behind you.$q$,
 $q$Phone VERTICAL, eye level, chest up. Face the window so the light is on your face. 30-45 seconds. 2-3 takes.$q$),

('b1-es-3','lo-fanis','es',3,$q$Préstamos DSCR en 30 segundos$q$,
 $q$¿Quieres comprar propiedades de renta sin mostrar tus impuestos? Escucha esto.$q$,
 $q$¿Quieres comprar propiedades de renta sin mostrar tus impuestos? Escucha esto.
Se llama préstamo DSCR. En vez de tus ingresos personales, miramos la propiedad: ¿la renta cubre el pago de la hipoteca?
Si la cubre, puedes calificar. Aunque trabajes por tu cuenta. Aunque tus impuestos muestren pérdida.
Puedes cerrar a nombre de tu LLC, y funciona para compras y para refinanciar con retiro de efectivo.
Soy Fanis, de Bridgepoint Lending. Escribe RENTA en los comentarios o mándame un mensaje y te enseño los números.$q$,
 $q$Same outfit as the others is fine, or a solid-color blouse. Keep it professional but relaxed.$q$,
 $q$In front of a house or duplex that looks like a rental (a nice, well-kept one), or a row of townhomes. Daytime, sun on your face.$q$,
 $q$Phone VERTICAL, eye level, chest up. 30-45 seconds. Say "Escribe RENTA" clearly and slowly at the end. 2-3 takes.$q$),

('b1-es-4','lo-fanis','es',4,$q$El error que acaba con el primer flip$q$,
 $q$Este error acaba con más primeros flips que cualquier otro.$q$,
 $q$Este error acaba con más primeros flips que cualquier otro: quedarte sin dinero para la reparación.
Compras la casa, empiezas la demolición, encuentras un problema detrás de la pared, y el dinero se acabó.
Tres soluciones. Uno: consigue el presupuesto del contratista ANTES de comprar. Dos: agrega un diez a quince por ciento para sorpresas. Tres: usa un préstamo que financie la reparación por etapas, para que no salga todo de tu bolsillo.
Eso hacemos en Bridgepoint Lending. Mándame tu presupuesto y lo revisamos contigo.
Solo propiedades de inversión.$q$,
 $q$Same as the others. Optional: hold a printed rehab budget or a clipboard.$q$,
 $q$At a job site: in front of a house with a dumpster, a work truck or scaffolding. If not, outside any house under renovation. Stay off the actual work area and wear closed shoes.$q$,
 $q$Phone VERTICAL, eye level, chest up. If it's noisy, move closer to the phone or step away from the work. 30-45 seconds. 2-3 takes.$q$),

-- ===== THERESA -- VIETNAMESE =====
('b1-vi-1','lo-theresa','vi',1,$q$3 con số cần kiểm tra trước khi đặt giá$q$,
 $q$Trước khi đặt giá mua một căn nhà để sửa và bán lại, hãy kiểm tra ba con số này.$q$,
 $q$Trước khi đặt giá mua một căn nhà để sửa và bán lại, hãy kiểm tra ba con số này.
Một: giá trị sau sửa chữa, hay ARV. Tức là giá những căn nhà tương tự gần đó đã THỰC SỰ BÁN được, không phải giá rao bán.
Hai: toàn bộ chi phí sửa chữa, cộng thêm mười đến mười lăm phần trăm cho những chi phí bất ngờ.
Ba: chi phí giữ nhà mỗi tháng. Tiền lãi, thuế, bảo hiểm và điện nước.
Nếu sau ba con số đó mà vẫn có lời, thì đó là một thương vụ tốt.
Tôi là Theresa, chuyên viên cho vay tại Bridgepoint Lending. Gửi cho tôi địa chỉ căn nhà, tôi sẽ cùng bạn tính toán miễn phí.
Chỉ dành cho bất động sản đầu tư.$q$,
 $q$Solid blazer or a nice sweater (navy, gray, black or white) over a plain top. No big logos, no busy patterns, no stripes. Natural makeup, hair away from your face. Same outfit is fine for all four videos.$q$,
 $q$Outside a house that looks like a fixer-upper, filmed from the sidewalk, or in front of any house being renovated. Daytime. Stand so the sun is on your face (behind the person filming), not behind you.$q$,
 $q$Phone held VERTICAL. Back camera if someone films you, front camera if you film yourself. Eye level, about an arm's length away, chest up in frame. Quiet spot, no music. Say the first line within the first 2 seconds, smile, then go. 30-45 seconds total. Do 2-3 takes and upload them all. The script is a guide: say it in your own natural Vietnamese, but keep the numbers and the last line ("Chỉ dành cho bất động sản đầu tư").$q$),

('b1-vi-2','lo-theresa','vi',2,$q$Vì sao ngân hàng từ chối bạn$q$,
 $q$Nếu ngân hàng từ chối khoản vay sửa nhà bán lại của bạn, đây là lý do.$q$,
 $q$Nếu ngân hàng từ chối khoản vay sửa nhà bán lại của bạn, đây là lý do.
Ngân hàng nhìn vào BẠN. W-2, tờ khai thuế, tỷ lệ nợ trên thu nhập.
Chúng tôi nhìn vào THƯƠNG VỤ.
Tại Bridgepoint, chúng tôi có thể tài trợ đến 90% giá mua và 100% chi phí sửa chữa cho những thương vụ đủ điều kiện, và tiền sửa chữa được giải ngân theo từng giai đoạn khi công việc hoàn thành. Không cần tờ khai thuế, không cần W-2.
Nếu bạn đã có hợp đồng mua nhà, hãy gửi cho tôi và tôi sẽ cho bạn biết chúng tôi có thể làm gì.
Tôi là Theresa từ Bridgepoint Lending. Chỉ dành cho bất động sản đầu tư.$q$,
 $q$Same as video 1: solid blazer or sweater, plain top, no logos or patterns.$q$,
 $q$Inside a room that's mid-renovation (bare drywall, exposed studs, tools or ladders in the background is perfect). If you can't get into one, a clean, bright kitchen or office with a plain wall behind you.$q$,
 $q$Phone VERTICAL, eye level, chest up. Face the window so the light is on your face. 30-45 seconds. 2-3 takes.$q$),

('b1-vi-3','lo-theresa','vi',3,$q$Khoản vay DSCR trong 30 giây$q$,
 $q$Bạn muốn mua nhà cho thuê mà không cần nộp tờ khai thuế? Hãy nghe đây.$q$,
 $q$Bạn muốn mua nhà cho thuê mà không cần nộp tờ khai thuế? Hãy nghe đây.
Đó là khoản vay DSCR. Thay vì xem thu nhập cá nhân của bạn, chúng tôi xem căn nhà: tiền thuê có đủ trả tiền vay hàng tháng không?
Nếu đủ, bạn có thể đủ điều kiện. Kể cả khi bạn tự kinh doanh. Kể cả khi tờ khai thuế của bạn bị lỗ.
Bạn có thể đứng tên công ty LLC, và áp dụng cho cả mua nhà lẫn tái cấp vốn rút tiền mặt.
Tôi là Theresa từ Bridgepoint Lending. Bình luận chữ THUÊ hoặc nhắn tin cho tôi, tôi sẽ tính cho bạn xem.$q$,
 $q$Same outfit as the others is fine, or a solid-color blouse. Keep it professional but relaxed.$q$,
 $q$In front of a house or duplex that looks like a rental (a nice, well-kept one), or a row of townhomes. Daytime, sun on your face.$q$,
 $q$Phone VERTICAL, eye level, chest up. 30-45 seconds. Say "Bình luận chữ THUÊ" clearly and slowly at the end. 2-3 takes.$q$),

('b1-vi-4','lo-theresa','vi',4,$q$Sai lầm khiến lần sửa nhà đầu tiên thất bại$q$,
 $q$Đây là sai lầm khiến nhiều nhà đầu tư mới thất bại nhất.$q$,
 $q$Đây là sai lầm khiến nhiều nhà đầu tư mới thất bại nhất: hết tiền sửa nhà giữa chừng.
Bạn mua nhà, bắt đầu đập phá, phát hiện vấn đề sau bức tường, và tiền đã hết.
Ba cách tránh. Một: lấy báo giá của nhà thầu TRƯỚC khi mua. Hai: cộng thêm mười đến mười lăm phần trăm cho chi phí bất ngờ. Ba: dùng khoản vay tài trợ tiền sửa chữa theo từng giai đoạn, để bạn không phải tự bỏ hết tiền túi.
Đó là điều chúng tôi làm tại Bridgepoint Lending. Gửi cho tôi bảng chi phí sửa chữa, tôi sẽ cùng bạn xem lại.
Chỉ dành cho bất động sản đầu tư.$q$,
 $q$Same as the others. Optional: hold a printed rehab budget or a clipboard.$q$,
 $q$At a job site: in front of a house with a dumpster, a work truck or scaffolding. If not, outside any house under renovation. Stay off the actual work area and wear closed shoes.$q$,
 $q$Phone VERTICAL, eye level, chest up. If it's noisy, move closer to the phone or step away from the work. 30-45 seconds. 2-3 takes.$q$);
