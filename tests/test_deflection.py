#!/usr/bin/env python3
"""Tests for the deflection detection gate in evaluate.py."""

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src", "evaluator"))

from evaluate import (
    is_deflection,
    DEFLECTION_PATTERNS_AR,
    DEFLECTION_PATTERNS_EN,
    DEFLECTION_NOINFO_AR,
    DEFLECTION_NOINFO_EN,
    DEFLECTION_HANDOFF_AR,
    DEFLECTION_HANDOFF_EN,
)


class TestIsDeflectionArabic:
    """Arabic deflection patterns should be detected."""

    def test_real_deflection_from_carloan(self):
        """The exact case that motivated this feature."""
        response = (
            "بقدر أساعدك بالمعلومات اللي عندي، بس بالنسبة للمستندات الإضافية "
            "المطلوبة تحديداً للمهنيين عند تحويل الراتب، ما عندي تفاصيل "
            "زيادة عنها حالياً. بتحب أوصلك على موظف مختص عشان يعطيك "
            "الجواب الأكيد؟"
        )
        assert is_deflection(response, language="ar") is True

    def test_ma_andi_tafaseel(self):
        assert is_deflection("ما عندي تفاصيل عن هذا الموضوع", language="ar") is True

    def test_ma_andi_malumat(self):
        assert is_deflection("ما عندي معلومات إضافية", language="ar") is True

    def test_andishi_tafaseel(self):
        assert is_deflection("معنديش تفاصيل", language="ar") is True

    def test_mash_mawjoud(self):
        assert is_deflection("مش متوفر عندي أي معلومات", language="ar") is True

    def test_wasslak_mowazaf(self):
        assert is_deflection("أوصلك على موظف مختص يساعدك", language="ar") is True

    def test_tahweelak_lamowazaf(self):
        assert is_deflection("تحويلك لموظف متخصص", language="ar") is True

    def test_aljawab_alkayyid(self):
        assert is_deflection("الجواب الأكيد عند الموظف المختص", language="ar") is True


class TestIsDeflectionArabicNegative:
    """Normal Arabic answers should NOT be flagged."""

    def test_normal_answer(self):
        response = (
            "تأمين المركبة الممولة يتطلب بطاقات التأمين والتسجيل"
        )
        assert is_deflection(response, language="ar") is False

    def test_answer_with_followup_offer(self):
        """An answer that ALSO offers follow-up should NOT deflect."""
        response = (
            "المستندات المطلوبة هي بطاقة التأمين وبطاقة التسجيل والهوية. "
            "بتحب أوصلك على موظف مختص عشان يعطيك تفاصيل أكثر؟"
        )
        assert is_deflection(response, language="ar") is False

    def test_empty_string(self):
        assert is_deflection("", language="ar") is False

    def test_greeting(self):
        assert is_deflection("أهلاً وسهلاً، كيف أقدر أساعدك؟", language="ar") is False

    def test_short_hedge_without_answer(self):
        """Short hedge with no preceding answer IS a deflection."""
        assert is_deflection("أوصلك على موظف مختص", language="ar") is True


class TestIsDeflectionEnglish:
    """English deflection patterns should be detected."""

    def test_connect_to_agent(self):
        assert is_deflection(
            "I don't have that info. Let me connect you with an agent.",
            language="en",
        ) is True

    def test_transfer_to_specialist(self):
        assert is_deflection(
            "I'm unable to answer that. Let me transfer you to a specialist.",
            language="en",
        ) is True

    def test_beyond_scope(self):
        assert is_deflection(
            "That's beyond my scope to answer.",
            language="en",
        ) is True

    def test_reach_out_to_team(self):
        assert is_deflection(
            "You should reach out to our support team for that.",
            language="en",
        ) is True


class TestIsDeflectionEnglishNegative:
    """Normal English answers should NOT be flagged."""

    def test_normal_answer(self):
        response = (
            "The required documents for vehicle insurance include the "
            "registration card and a valid driving license."
        )
        assert is_deflection(response, language="en") is False

    def test_answer_with_followup(self):
        """A substantive answer followed by a follow-up offer."""
        response = (
            "You need your ID, registration, and insurance card. "
            "Would you like me to connect you with an agent for more details?"
        )
        assert is_deflection(response, language="en") is False

    def test_short_hedge_without_answer(self):
        """Short hedge with no preceding answer IS a deflection."""
        assert is_deflection("Let me connect you to an agent.", language="en") is True


class TestRegressionRealMissesArabic:
    """Verbatim refusal/hedge responses from real captured sessions that the
    old (fixed-phrase) patterns missed. Each must now be flagged."""

    def test_ar_001_t2_apology_noinfo(self):
        assert is_deflection(
            "بعتذر منك، ما قدرت ألاقي معلومات دقيقة عن القرض الفوري ضمن اللي "
            "بقدر أساعدك فيه حالياً. بتحب أوصلك على موظف مختص يساعدك أكتر "
            "بهالموضوع؟",
            language="ar",
        ) is True

    def test_ar_004_t8_ma_andi_balano(self):
        assert is_deflection(
            "بعتذر منك، بس ما عندي معلومة بخصوص الحد الأدنى للراتب المطلوب "
            "للقرض الفوري مقابل بطاقة ائتمانية ضمن المعلومات المتوفرة عندي "
            "حالياً. بتحب أوصلك على موظف من عنا بقدر يساعدك بهاد الموضوع؟",
            language="ar",
        ) is True

    def test_ar_004_t10_ma_lqayt(self):
        assert is_deflection(
            "بعتذر منك، بس ما لقيت معلومة بتخص شو بصير بخيار القرض الفوري بعد "
            "ما العميل ياخذه ضمن المعلومات المتوفرة عندي حالياً. بتحب أوصلك على "
            "موظف من عنا بقدر يساعدك بهاد الموضوع؟",
            language="ar",
        ) is True

    def test_ar_005_t3_belnisba_llasaf(self):
        """Long question-echo prefix, then 'للأسف ما عندي ...'."""
        assert is_deflection(
            "بالنسبة لسؤالك عن الحد الأدنى لصافي الراتب لموظفي البنك المركزي "
            "والسيتي بانك بالتحديد، للأسف ما عندي هاي المعلومة بالتفصيل في قاعدة "
            "البيانات عندي. بقدر أوصلك على موظف من البنك إذا حابب يساعدك بهاد "
            "الموضوع؟",
            language="ar",
        ) is True

    def test_ar_005_t6_question_echo_llasaf(self):
        assert is_deflection(
            "بالنسبة لسؤالك عن الحد الأدنى لمبلغ القرض الفوري مقابل بطاقة "
            "ائتمانية، للأسف ما عندي هاي المعلومة بالتحديد حالياً. بتحب أوصلك "
            "على موظف من البنك عشان يجاوبك بدقة على هذا الموضوع؟",
            language="ar",
        ) is True

    def test_ar_007_t6_ma_bethaded(self):
        """'بخصوص ...، المعلومات المتوفرة عندي ما بتحدد ...' reversed order."""
        assert is_deflection(
            "بخصوص القرض السكني، المعلومات المتوفرة عندي حالياً ما بتحدد الحد "
            "الأقصى للمبلغ في حال عدم تحويل الراتب، لأن التفاصيل المتاحة بتخص "
            "جوانب تانية. بقدر أوصلك على موظف مختص من عنا ليعطيك المعلومة "
            "الدقيقة، بتحب أعملك هيك؟",
            language="ar",
        ) is True

    def test_ar_009_t3_ma_bethaded_count(self):
        assert is_deflection(
            "بخصوص عدد مرات الحصول على قرض، المعلومات المتوفرة عندي ما بتحدد "
            "عدد مرات معين، بس بتقدر تطلب زيادة رصيد قرضك الحالي إذا كان الحد "
            "الأدنى للزيادة خمسمية دينار وبشرط إنك تكون ملتزم بالسداد.",
            language="ar",
        ) is True

    def test_ar_003_t5_ma_andi_daqiqa(self):
        assert is_deflection(
            "بعتذر منك، بس ما عندي معلومة دقيقة بخصوص طريقة قيد مبلغ القرض "
            "الفوري حالياً. بقدر أوصلك على موظف من طرفنا ليقدر يجاوبك على هاد "
            "السؤال بالتفصيل؟",
            language="ar",
        ) is True

    def test_ar_handoff_only_mowazaf(self):
        assert is_deflection("أوصلك على موظف مختص", language="ar") is True


class TestRegressionRealMissesEnglish:
    """Verbatim EN refusals the old fixed-phrase patterns missed."""

    def test_en_001_t3_sorry_no_specific(self):
        assert is_deflection(
            "I'm sorry, but I don't have specific information regarding the "
            "period for an Instant Loan against a credit card. Would you like "
            "me to connect you with a human representative who can look into "
            "that for you?",
            language="en",
        ) is True

    def test_en_010_t5_no_specific_list(self):
        assert is_deflection(
            "I'm sorry, I don't have a specific list of entities that are "
            "exempt from the conditional salary transfer commitment for "
            "personal loans. Would you like me to connect you with a "
            "representative who can provide you with that exact information?",
            language="en",
        ) is True

    def test_en_005_t8_couldnt_find(self):
        assert is_deflection(
            "I'm sorry, I couldn't find specific information regarding how an "
            "instant loan amount is credited. Would you like me to connect you "
            "with a human representative who can provide more detailed "
            "information on this?",
            language="en",
        ) is True

    def test_en_001_t7_no_complete_list(self):
        assert is_deflection(
            "I'm sorry, I don't have a complete list of all the loan types we "
            "offer at the moment. However, I can tell you that we generally "
            "provide various options including personal loans, housing loans, "
            "and car loans.",
            language="en",
        ) is True


class TestRegressionNoFalsePositives:
    """Real answers that merely echo the question / offer follow-up must NOT
    be flagged, even though they contain hedge-style words."""

    def test_ar_450_dinar_answer_with_followup(self):
        """The user-specified negative: a real answer then a follow-up offer."""
        assert is_deflection(
            "الحد الأدنى هو 450 دينار. بقدر أساعدك بشي ثاني؟",
            language="ar",
        ) is False

    def test_en_answer_with_followup(self):
        assert is_deflection(
            "You need your ID, registration, and insurance card. "
            "Would you like me to connect you with an agent for more details?",
            language="en",
        ) is False

    def test_ar_001_t5_llasaf_but_real_answer(self):
        """'للأسف' appears, but the response actually answers (not financed)."""
        assert is_deflection(
            "بناءً على المعلومات المتاحة عندي، موظفي البلديات وعمال المياومة "
            "للأسف ما بقدر يتم تمويلهم للقرض السكني. بقدر أساعدك بأي استفسار "
            "ثاني؟",
            language="ar",
        ) is False

    def test_ar_009_t10_real_ratios_then_offer(self):
        assert is_deflection(
            "بناءً على المعلومات المتوفرة عندي بخصوص القروض العقارية، بالنسبة "
            "لبناء شقتك الخاصة، نسبة التمويل بتوصل لغاية مية بالمية. أما بخصوص "
            "الشقق الجاهزة، فالمعلومات المتاحة بتحدد نسب التمويل حسب القطاع، بس "
            "ما ذكرت بالتفصيل نسبة التمويل الخاصة بالمهنيين عند شراء شقق جاهزة "
            "مع تحويل راتب. بقدر أوصلك على موظف من عندنا إذا حبيت عشان يعطيك "
            "تفاصيل أدق؟",
            language="ar",
        ) is False

    def test_en_003_t7_real_policy_answer(self):
        assert is_deflection(
            "Loans are generally prohibited for those below the rank of "
            "Warrant Officer Wakil, even if the salary is transferred to the "
            "bank. However, there is an exception where loans may be possible "
            "by transferring a deduction. Is there anything else I can help "
            "you with today?",
            language="en",
        ) is False

    def test_en_004_t4_real_eligibility(self):
        assert is_deflection(
            "Not all customers are eligible for an instant personal loan via "
            "the banking app. There are specific eligibility requirements, "
            "including a minimum net income of four hundred and fifty "
            "Jordanian Dinars and a minimum age of twenty two years.",
            language="en",
        ) is False


class TestDeflectionLogging:
    """The matched pattern is reported to stderr for tuning."""

    def test_match_is_logged_to_stderr(self, capsys):
        is_deflection("ما عندي معلومات عن هذا الموضوع", language="ar")
        out = capsys.readouterr().err
        assert "[deflection]" in out
        assert "ما عندي" in out


class TestPatternsAreEditable:
    """Pattern lists should be module-level and mutable."""

    def test_ar_patterns_are_list(self):
        assert isinstance(DEFLECTION_PATTERNS_AR, list)
        assert len(DEFLECTION_PATTERNS_AR) > 0

    def test_en_patterns_are_list(self):
        assert isinstance(DEFLECTION_PATTERNS_EN, list)
        assert len(DEFLECTION_PATTERNS_EN) > 0

    def test_all_patterns_are_valid_regex(self):
        import re
        for p in DEFLECTION_PATTERNS_AR + DEFLECTION_PATTERNS_EN:
            re.compile(p)  # should not raise

    def test_noinfo_and_handoff_subgroups_exist(self):
        assert len(DEFLECTION_NOINFO_AR) > 0
        assert len(DEFLECTION_NOINFO_EN) > 0
        assert len(DEFLECTION_HANDOFF_AR) > 0
        assert len(DEFLECTION_HANDOFF_EN) > 0

    def test_combined_lists_are_union_of_subgroups(self):
        assert DEFLECTION_PATTERNS_AR == DEFLECTION_NOINFO_AR + DEFLECTION_HANDOFF_AR
        assert DEFLECTION_PATTERNS_EN == DEFLECTION_NOINFO_EN + DEFLECTION_HANDOFF_EN
